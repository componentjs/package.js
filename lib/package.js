
/**
 * Module dependencies.
 */

var Emitter = require('events').EventEmitter;
var path = require('path');
var dirname = path.dirname;
var resolve = path.resolve;
var mkdir = require('mkdirp').mkdirp;
var netrc = require('netrc');
var debug = require('debug')('component:package');
var url = require('url');
var parse = url.parse;
var fs = require('graceful-fs');
var rimraf = require('rimraf');
var http = require('http');
var inherit = require('util').inherits;
var co = require('co');
var request = require('cogent');
var archan = require('archan');

/**
 * In-flight requests.
 */

var inFlight = {};

/**
 * Expose installer.
 */

module.exports = Package;

/**
 * Initialize a new `Package` with
 * the given `pkg` name and `version`.
 *
 * Options:
 *
 *  - `dest` destination directory
 *  - `force` installation when previously installed
 *  - `remote` remote url defaulting to "https://raw.github.com"
 *
 * @param {String} pkg
 * @param {String} version
 * @param {Object} options
 * @api private
 */

function Package(pkg, version, options) {
  options = options || {};
  if ('*' == version) version = 'master';
  debug('installing %s@%s %j', pkg, version, options);
  if (!pkg) throw new Error('pkg required');
  if (!version) throw new Error('version required');
  this.name = pkg;
  this.slug = pkg + '@' + version;
  this.dest = options.dest || 'components';
  this.remotes = options.remotes || ['https://raw.github.com'];
  this.auth = options.auth;
  this.netrc = netrc(options.netrc);
  this.force = !! options.force;
  this.version = version;
  this.concurrency = options.concurrency;
  this.channel = archan({
    concurrency: this.concurrency
  });
}

/**
 * Inherit from `Emitter`.
 */

inherit(Package, Emitter);

/**
 * Return dirname for this package.
 * For example "component/dialog"
 * becomes "component-dialog".
 *
 * @return {String}
 * @api private
 */

Package.prototype.dirname = function(){
  return resolve(this.dest, this.name.split('/').join('-'));
};

/**
 * Join `path` to this package's dirname.
 *
 * @param {String} path
 * @return {String}
 * @api private
 */

Package.prototype.join = function(path){
  return resolve(this.dirname(), path);
};

/**
 * Return URL to `file`.
 *
 * @param {String} file
 * @return {String}
 * @api private
 */

Package.prototype.url = function(file){
  var remote = this.remote
    ? this.remote.href
    : this.remotes[0];

  return remote + '/' + this.name + '/' + this.version + '/' + file;
};

/**
 * Conditionaly mkdir `dir` unless we've
 * already done so previously.
 *
 * @param {String} dir
 * @api private
 */

Package.prototype.mkdir = function* (dir){
  this.dirs = this.dirs || {};
  if (!this.dirs[dir]) yield mkdir.bind(null, dir);
};

/**
 * Destroy the package contents in case of error
 *
 * @api private
 */

Package.prototype.destroy = function* (){
  yield rimraf.bind(null, this.dirname());
};

/**
 * Get local json if the component is installed.
 *
 * @api private
 */

Package.prototype.getLocalJSON = function* (){
  var path = this.join('component.json');
  var json = yield fs.readFile.bind(null, path, 'utf8');
  try {
    return JSON.parse(json);
  } catch (err) {
    err.message += ' in ' + path;
    throw err;
  }
};

/**
 * Get component.json.
 *
 * @api private
 */

Package.prototype.getJSON = function* (){
  var url = this.url('component.json');

  debug('fetching %s', url);

  var options = {
    json: true,
  };

  // authorize call
  var hostname = parse(url).hostname;
  var auth = encodeAuth(this, hostname);
  if (auth) {
    options.headers = {
      'Authorization': auth,
    };
  }

  var res
  try {
    res = yield* request(url, options);
  } catch (err) {
    if ('getaddrinfo' == err.syscall) err.message = 'dns lookup failed';
    else err.message += ' in ' + url;
    throw err;
  }
  if (res.statusCode !== 400) throw error(res.res, url);
  return res.body;
};

/**
 * Fetch `files` and write them to disk.
 *
 * @param {Array} files
 * @api private
 */

Package.prototype.getFiles = function* (files){
  var ch = this.channel;
  for (var i = 0; i < files.length; i++) {
    yield* ch.drain();
    co.call(this, this.getFile(files[i]))(ch.push());
  }
};

Package.prototype.getFile = function* (file) {
  // to do: auth support from Package.prototype.request
  var url = this.url(file);
  debug('fetching %s', url);
  this.emit('file', file, url);
  var dst = this.join(file);
  yield* this.mkdir(dirname(dst));
  var res = yield* request(url, dst);
  if (res.statusCode !== 200) throw error(res, url);
}

/**
 * Write `file` with `str` contents to disk.
 *
 * @param {String} file
 * @param {String} str
 * @api private
 */

Package.prototype.writeFile = function* (file, str){
  file = this.join(file);
  debug('write %s', file);
  yield fs.writeFile.bind(null, file, str);
};

/**
 * Install `deps`.
 *
 * @param {Array} deps
 * @api private
 */

Package.prototype.getDependencies = function* (deps){
  var ch = this.channel;
  for (var name in deps) if ({}.hasOwnProperty.call(deps, name)) {
    yield* ch.drain();
    var version = deps[name];
    debug('dep %s@%s', name, version);
    var pkg = new Package(name, version, {
      dest: this.dest,
      force: this.force,
      remotes: this.remotes,
    });
    this.emit('dep', pkg);
    pkg.end(ch.push());
  }
};

Package.prototype.end = function (cb) {
  co.call(this, this.install())(cb);
}

/**
 * Check if the component exists already,
 * otherwise install it for realllll.
 *
 * @api public
 */

Package.prototype.install = function* (){
  if (inFlight[this.slug]) return;

  var name = this.name;
  inFlight[this.slug] = true;

  if (!~name.indexOf('/')) {
    throw new Error('invalid component name "' + name + '"');
  }

  try {
    yield* this.getLocalJSON();
  } catch (err) {
    // doesn't exist, install
    if (err.code === 'ENOENT') return yield* this.reallyInstall();
    // actual error
    throw err;
  }

  // already installed, don't overwrite
  if (!this.force) return this.exists = true;

  // forced install
  yield* this.reallyInstall();
};

/**
 * Really install the component.
 *
 * @api public
 */

Package.prototype.reallyInstall = function* (){
  var i = 0;
  var remote;
  var last;
  while (remote = this.remotes[i++]) {
    // parse remote
    last = i == this.remotes.length;
    this.remote = url.parse(remote);

    // strip trailing /
    this.remote.href = this.remote.href.slice(0, -1);

    // only error on the last remote otherwise
    // we assume it may be fetchable
    var json
    try {
      json = yield* this.getJSON();
    } catch (err) {
      if (last) throw err;
      else continue;
    }

    var files = [];
    if (json.scripts) files = files.concat(json.scripts);
    if (json.styles) files = files.concat(json.styles);
    if (json.templates) files = files.concat(json.templates);
    if (json.files) files = files.concat(json.files);
    if (json.images) files = files.concat(json.images);
    if (json.fonts) files = files.concat(json.fonts);
    if (json.json) files = files.concat(json.json);
    json.repo = json.repo || this.remote.href + '/' + this.name;

    if (json.dependencies) yield* this.getDependencies(json.dependencies);

    yield* this.mkdir(this.dirname());
    json = JSON.stringify(json, null, 2);
    yield* this.writeFile('component.json', json);
    yield* this.getFiles(files);
    yield* this.channel.flush();
  }

  // failed
  yield* this.destroy();
  throw new Error('can\'t find remote for "' + this.name + '"');
};

/**
 * Return an error for `res` / `url`.
 *
 * @param {Response} res
 * @param {String} url
 * @return {Error}
 * @api private
 */

function error(res, url) {
  var name = http.STATUS_CODES[res.statusCode];
  var err = new Error('failed to fetch ' + url + ', got ' + res.statusCode + ' "' + name + '"');
  err.status = res.statusCode;
  return err;
}

/**
 * Returns an HTTP Basic auth header string, either from being manually
 * passed in credentials or from the .netrc file, or `null` if no
 * authentication information is found.
 *
 * @param {Package} pkg
 * @param {String} hostname
 * @return {String}
 * @api private
 */

function encodeAuth(pkg, hostname) {
  var auth = pkg.auth || pkg.netrc[hostname];
  if (!auth) return;
  var u = auth.user || auth.username || auth.login;
  var p = auth.pass || auth.password;
  return 'Basic ' + new Buffer(u + ':' + p).toString('base64');
}

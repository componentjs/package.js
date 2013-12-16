
/**
 * Module dependencies.
 */

var Emitter = require('events').EventEmitter;
var path = require('path');
var dirname = path.dirname;
var basename = path.basename;
var extname = path.extname;
var resolve = path.resolve;
var mkdir = require('mkdirp').mkdirp;
var netrc = require('netrc');
var debug = require('debug')('component:package');
var Batch = require('batch');
var url = require('url');
var parse = url.parse;
var fs = require('graceful-fs');
var rimraf = require('rimraf');
var http = require('http');
var https = require('https');
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
 * @param {Function} fn
 * @api private
 */

Package.prototype.mkdir = function(dir, fn){
  this.dirs = this.dirs || {};
  if (this.dirs[dir]) return fn();
  mkdir(dir, fn);
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
 * Get local json if the component is installed
 * and callback `fn(err, obj)`.
 *
 * @api private
 */

Package.prototype.getLocalJSON = function* (){
  var path = this.join('component.json');
  var json = fs.readFile.bind(null, path, 'utf8');
  try {
    return JSON.parse(json);
  } catch (err) {
    err.message += ' in ' + path;
    throw err;
  }
};

/**
 * Get component.json and callback `fn(err, obj)`.
 *
 * @param {Function} fn
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
 * Fetch `files` and write them to disk and callback `fn(err)`.
 *
 * @param {Array} files
 * @param {Function} fn
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
  self.emit('file', file, url);
  var dst = self.join(file);
  yield fs.mkdir.bind(null, dirname(dst));
  var res = yield* request(url, dst);
  if (res.statusCode !== 200) throw error(res, url);
}

/**
 * Write `file` with `str` contents to disk and callback `fn(err)`.
 *
 * @param {String} file
 * @param {String} str
 * @param {Function} fn
 * @api private
 */

Package.prototype.writeFile = function* (file, str){
  file = this.join(file);
  debug('write %s', file);
  yield fs.writeFile.bind(null, file, str);
};

/**
 * Install `deps` and callback `fn()`.
 *
 * @param {Array} deps
 * @param {Function} fn
 * @api private
 */

Package.prototype.getDependencies = function(deps, fn){
  var ch = this.channel;
  for (var key in deps) if ({}.hasOwnProperty.call(deps, key)) {
    yield* ch.drain();
    var version = deps[name];
    debug('dep %s@%s', name, version);
    var pkg = new Package(name, version, {
      dest: self.dest,
      force: self.force,
      remotes: self.remotes,
    });
    self.emit('dep', pkg);
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
  var self = this;
  var name = this.name;

  if (inFlight[this.slug]) {
    this.install = this.emit.bind(this, 'end');
    this.inFlight = true;
  }
  inFlight[this.slug] = true;

  if (!~name.indexOf('/')) {
    return this.emit('error', new Error('invalid component name "' + name + '"'));
  }

  this.getLocalJSON(function(err, json){
    if (err && err.code == 'ENOENT') {
      self.reallyInstall();
    } else if (err) {
      self.emit('error', err);
    } else if (!self.force) {
      self.emit('exists', self);
    } else {
      self.reallyInstall();
    }
  });
};

/**
 * Really install the component.
 *
 * @api public
 */

Package.prototype.reallyInstall = function* (){
  var self = this;
  var i = 0;
  var batch;
  var last;

  next();

  function next() {
    self.remote = self.remotes[i++];
    if (!self.remote) {
      return self.destroy(function (error) {
        if (error) self.emit('error', error);
        self.emit('error', new Error('can\'t find remote for "' + self.name + '"'));
      });
    }

    // parse remote
    last = i == self.remotes.length;
    self.remote = url.parse(self.remote);

    // strip trailing /
    self.remote.href = self.remote.href.slice(0, -1);

    // only error on the last remote otherwise
    // we assume it may be fetchable
    self.once('error', next);

    // kick off installation
    batch = new Batch;
    self.getJSON(function(err, json){
      if (err) {
        err.fatal = 404 != err.status || last;
        return self.emit('error', err);
      }

      var files = [];
      if (json.scripts) files = files.concat(json.scripts);
      if (json.styles) files = files.concat(json.styles);
      if (json.templates) files = files.concat(json.templates);
      if (json.files) files = files.concat(json.files);
      if (json.images) files = files.concat(json.images);
      if (json.fonts) files = files.concat(json.fonts);
      if (json.json) files = files.concat(json.json);
      json.repo = json.repo || self.remote.href + '/' + self.name;

      if (json.dependencies) {
        batch.push(function(done){
          self.getDependencies(json.dependencies, done);
        });
      }

      batch.push(function(done){
        self.mkdir(self.dirname(), function(err){
          json = JSON.stringify(json, null, 2);
          self.writeFile('component.json', json, done);
        });
      });

      batch.push(function(done){
        self.mkdir(self.dirname(), function(err){
          self.getFiles(files, done);
        });
      });

      batch.end(function(err){
        if (err) {
          err.fatal = last;
          self.emit('error', err);
        }

        self.emit('end');
      });
    });
  }
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

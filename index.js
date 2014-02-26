
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
var debug = require('debug')('component:package');
var Batch = require('batch');
var url = require('url');
var parse = url.parse;
var fs = require('fs');
var rimraf = require('rimraf');
var http = require('http');
var https = require('https');
var inherit = require('util').inherits;
var co = require('co');
var request = co(require('cogent'));

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
  this.netrc = options.netrc;
  this.force = !! options.force;
  this.proxy = options.proxy || process.env.https_proxy;
  this.version = version;
  this.concurrency = options.concurrency;
  if (inFlight[this.slug]) {
    this.install = this.emit.bind(this, 'end');
    this.inFlight = true;
  }
  inFlight[this.slug] = true;
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
  return resolve(this.dest, this.name.toLowerCase().split('/').join('-'));
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
 * @param {Function} fn
 * @api private
 */

Package.prototype.destroy = function(fn){
  rimraf(this.dirname(), fn);
};

/**
 * Check if the package exists locally.
 *
 * @param {Function} fn
 * @api private
 */

Package.prototype.exists = function(fn){
  var path = this.join('component.json');
  fs.exists(path, fn);
};

/**
 * Get component.json and callback `fn(err, obj)`.
 *
 * @param {Function} fn
 * @api private
 */

Package.prototype.getJSON = function(fn){
  var url = this.url('component.json');

  debug('fetching %s', url);
  request(url, {
    proxy: this.proxy,
    netrc: this.netrc,
    auth: this.auth,
    json: true,
  }, function (err, res) {
    if (err) {
      if ('getaddrinfo' == err.syscall) err.message = 'dns lookup failed';
      fn(err);
      return;
    }
    if (res.statusCode !== 200) return fn(error(res, url));
    fn(null, res.body);
  })
};

/**
 * Fetch `files` and write them to disk and callback `fn(err)`.
 *
 * @param {Array} files
 * @param {Function} fn
 * @api private
 */

Package.prototype.getFiles = function(files, fn){
  var self = this;
  var batch = new Batch;

  if (this.concurrency) batch.concurrency(this.concurrency);

  files.forEach(function(file){
    batch.push(function(done){
      var url = self.url(file);
      debug('fetching %s', url);
      self.emit('file', file, url);
      var dst = self.join(file);

      request(url, {
        proxy: self.proxy,
        netrc: self.netrc,
        auth: self.auth,
        destination: dst,
      }, function (err, res) {
        if (err) return done(err);
        if (res.statusCode !== 200) return done(err(res, url));
        done();
      });
    });
  });

  batch.end(fn);
};

/**
 * Write `file` with `str` contents to disk and callback `fn(err)`.
 *
 * @param {String} file
 * @param {String} str
 * @param {Function} fn
 * @api private
 */

Package.prototype.writeFile = function(file, str, fn){
  file = this.join(file);
  debug('write %s', file);
  fs.writeFile(file, str, fn);
};

/**
 * Install `deps` and callback `fn()`.
 *
 * @param {Array} deps
 * @param {Function} fn
 * @api private
 */

Package.prototype.getDependencies = function(deps, fn){
  var self = this;
  var batch = new Batch;

  Object.keys(deps).forEach(function(name){
    var version = deps[name];
    debug('dep %s@%s', name, version);
    batch.push(function(done){
      var pkg = new Package(name, version, {
        dest: self.dest,
        force: self.force,
        remotes: self.remotes,
        proxy: self.proxy
      });
      self.emit('dep', pkg);
      pkg.on('end', done);
      pkg.on('exists', function() { done(); });
      pkg.install();
    });
  });

  batch.end(fn);
};

/**
 * Check if the component exists already,
 * otherwise install it for realllll.
 *
 * @api public
 */

Package.prototype.install = function(){
  var self = this;
  var name = this.name;

  if (!~name.indexOf('/')) {
    return this.emit('error', new Error('invalid component name "' + name + '"'));
  }

  this.exists(function(exists){
    if (exists && !self.force) {
      self.emit('exists', self);
      return;
    }

    self.reallyInstall();
  });
};

/**
 * Really install the component.
 *
 * @api public
 */

Package.prototype.reallyInstall = function(){
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
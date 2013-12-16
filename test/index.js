
var Package = require('..');
var path = require('path');
var fs = require('fs');

var pkg;
var repo = 'component/tip';
var version = '0.3.0';

describe('Package.js', function () {
  beforeEach(function () {
    pkg = new Package(repo, version);
  });

  it('should have some settings', function () {
    pkg.name.should.eql(repo);
    pkg.version.should.eql(version);
    pkg.slug.should.eql(repo + '@' + version);
    pkg.dest.should.eql('components');
  });

  it('should change "*" to "master"', function () {
    pkg = new Package(repo, '*');
    pkg.version.should.eql('master');
  });

  describe('#dirname()', function () {
    it('should return the dirname', function () {
      pkg.dirname().should.eql(path.resolve('components/component-tip'));
    });
  });

  describe('#join(path)', function () {
    it('should return the path', function () {
      pkg.join('lib').should.eql(path.resolve('components/component-tip/lib'));
    });
  });

  describe('#url(file)', function () {
    it('should return the url', function () {
      pkg.url('index.js').should.eql('https://raw.github.com/' + repo + '/' + version + '/index.js');
    });
  });

  describe('Install', function () {
    var dest = path.join(__dirname, '..', 'components')
    var folder = path.join(dest, 'component-domify')
    var pkg = new Package('component/domify', '1.1.1', {
      dest: dest
    })

    it('should install', function (done) {
      pkg.end(function (err) {
        if (err) return done(err);
        fs.statSync(path.join(folder, 'component.json'))
        fs.statSync(path.join(folder, 'index.js'))
        done();
      })
    })
  })
});
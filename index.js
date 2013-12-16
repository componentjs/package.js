try {
  module.exports = require('./lib/package.js')
} catch (err) {
  module.exports = require('./build/package.js')
}
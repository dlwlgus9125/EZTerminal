// run-script e2e fixture: a throwing default export renders as an error block.
module.exports = function () {
  throw new Error('deliberate script failure');
};

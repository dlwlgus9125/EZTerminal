// pnpm lifecycle hook configuration
module.exports = {
  hooks: {
    readPackage(pkg) {
      return pkg;
    },
  },
};

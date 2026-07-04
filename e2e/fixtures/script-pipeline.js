// run-script e2e fixture: `ez.run(...)` runs a pipeline inline against the
// live session, and the script transforms the returned rows before handing
// them back as its own (table) result.
module.exports = async function () {
  const { rows } = await ez.run('gen-rows 5 | where n > 2');
  return rows.map((r) => ({ n: r.n, doubled: r.n * 2 }));
};

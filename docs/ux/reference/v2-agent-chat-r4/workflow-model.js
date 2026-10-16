/* Deterministic review model. No provider, filesystem, subprocess or network execution. */
(() => {
  const clone = value => structuredClone(value);
  function preset(kind, en = false) {
    const n = (id, ko, english, type = 'stage') => ({id, title: en ? english : ko, type, brief: '', provider: 'codex'});
    const e = (from, to, when = 'always') => ({from, to, when});
    let nodes, edges;
    if (kind === 'parallel') {
      nodes = [n('plan','요구사항','Requirements'),n('fork','병렬로 시작','Start parallel','fork'),n('ui','화면 구현','UI implementation'),n('api','API 구현','API implementation'),n('join','결과 모으기','Collect results','join'),n('review','검토','Review'),n('approve','사용자 승인','Human approval','approval'),n('done','완료','Done','finish')];
      edges = [e('plan','fork'),e('fork','ui'),e('fork','api'),e('ui','join'),e('api','join'),e('join','review'),e('review','approve'),e('approve','done')];
    } else if (kind === 'research') {
      nodes = [n('research','조사','Research'),n('summary','정리','Synthesis'),n('approve','내용 확인','Confirm findings','approval'),n('done','완료','Done','finish')];
      edges = [e('research','summary'),e('summary','approve'),e('approve','done')];
    } else if (kind === 'blank') {
      nodes = [n('start','첫 단계','First stage'),n('done','완료','Done','finish')]; edges = [e('start','done')];
    } else {
      nodes = [n('plan','기획','Planning'),...(kind === 'bug' ? [] : [n('design','디자인','Design')]),n('build','구현','Implementation'),n('review','검토','Review'),n('condition','검토 결과','Review outcome','condition'),n('approve','사용자 승인','Human approval','approval'),n('done','완료','Done','finish')];
      edges = kind === 'bug' ? [e('plan','build')] : [e('plan','design'),e('design','build')];
      edges.push(e('build','review'),e('review','condition'),e('condition','approve','pass'),e('condition','build','fail'),e('approve','done'));
    }
    return {revision: 1, entry: nodes[0].id, retryLimit: 2, nodes, edges};
  }
  function validate(g) {
    const errors = [], ids = new Set(g.nodes.map(n => n.id));
    if (ids.size !== g.nodes.length) errors.push('duplicate');
    if (!ids.has(g.entry)) errors.push('entry');
    if (!g.nodes.some(n => n.type === 'finish')) errors.push('finish');
    const key = new Set();
    for (const edge of g.edges) {
      const k = `${edge.from}/${edge.to}/${edge.when}`;
      if (key.has(k)) errors.push('duplicate-edge'); key.add(k);
      if (!ids.has(edge.from) || !ids.has(edge.to)) errors.push('dangling');
    }
    for (const node of g.nodes) {
      const out = g.edges.filter(e => e.from === node.id), incoming = g.edges.filter(e => e.to === node.id);
      if (!node.title.trim()) errors.push('title');
      if (node.type === 'finish' ? out.length : !out.length) errors.push('output');
      if (node.type === 'condition') {
        if (out.length !== 2 || !out.some(e => e.when === 'pass') || !out.some(e => e.when === 'fail')) errors.push('condition');
      } else if (out.some(e => e.when !== 'always')) errors.push('condition-port');
      if (node.type === 'fork' && out.length < 2) errors.push('fork');
      if (!['fork','condition','finish'].includes(node.type) && out.length !== 1) errors.push('single-output');
      if (node.type === 'join' && incoming.length < 2) errors.push('join');
    }
    const reached = new Set();
    const visit = id => {if (reached.has(id)) return; reached.add(id); g.edges.filter(e => e.from === id).forEach(e => visit(e.to));};
    visit(g.entry); if (g.nodes.some(n => !reached.has(n.id))) errors.push('unreachable');
    const done = new Set(), stack = new Set();
    function cycle(id) {
      if (stack.has(id)) return true; if (done.has(id)) return false;
      stack.add(id);
      if (g.edges.filter(e => e.from === id && e.when !== 'fail').some(e => cycle(e.to))) return true;
      stack.delete(id); done.add(id); return false;
    }
    if (g.nodes.some(n => cycle(n.id))) errors.push('cycle');
    return [...new Set(errors)];
  }
  function createRun(graph, id) {
    if (validate(graph).length) return null;
    return {id, graph: clone(graph), status: 'running', active: [graph.entry], arrivals: {}, completed: [], events: [], retries: 0, approvals: [], sequence: 0};
  }
  function advance(run, outcome = 'pass', approvedId = null) {
    if (!run || !['running','waiting'].includes(run.status)) return;
    const graph = run.graph, next = [], waiting = [];
    const enqueue = (target, from) => {
      const node = graph.nodes.find(n => n.id === target);
      if (node.type === 'join') {
        const arrived = run.arrivals[target] ||= [];
        if (!arrived.includes(from)) arrived.push(from);
        const expected = graph.edges.filter(e => e.to === target && e.when !== 'fail').map(e => e.from);
        if (!expected.every(id => arrived.includes(id))) return;
        delete run.arrivals[target];
      }
      if (!next.includes(target)) next.push(target);
    };
    for (const id of run.active) {
      const node = graph.nodes.find(n => n.id === id);
      if (node.type === 'approval' && approvedId !== id) {waiting.push(id); continue;}
      if (node.type === 'condition' && outcome === 'fail' && run.retries >= graph.retryLimit) {
        run.status = 'blocked'; run.active = [id]; run.events.push({id: ++run.sequence, nodeId: id, outcome: 'retry-limit'}); return;
      }
      if (node.type === 'approval') run.approvals.push({nodeId:id, sequence:run.sequence+1});
      run.events.push({id: ++run.sequence, nodeId: id, outcome: node.type === 'condition' ? outcome : 'completed'});
      if (!run.completed.includes(id)) run.completed.push(id);
      if (node.type === 'condition' && outcome === 'fail') run.retries++;
      graph.edges.filter(e => e.from === id && (e.when === 'always' || e.when === outcome)).forEach(e => enqueue(e.to, id));
    }
    run.active = [...new Set([...waiting,...next])];
    run.status = run.active.length ? (run.active.every(id => graph.nodes.find(n => n.id === id).type === 'approval') ? 'waiting' : 'running') : (Object.keys(run.arrivals).length ? 'blocked' : 'completed');
  }
  window.WORKFLOW_REVIEW = {preset, validate, createRun, advance, clone};
})();

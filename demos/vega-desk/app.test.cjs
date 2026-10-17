const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM adapter exercises state transitions without a browser dependency.
// It does not verify layout, accessibility trees, or real-browser rendering.
function harness() {
  const samples = JSON.parse(fs.readFileSync(path.join(__dirname, 'samples.json'), 'utf8'));
  const elements = new Map();
  class Element {
    constructor(id) {
      this.id = id; this.value = id === 'threshold' ? '80' : ''; this.hidden = false;
      this.disabled = false; this.innerHTML = ''; this.textContent = ''; this.handlers = {};
      this.classList = {toggle() {}};
    }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    setAttribute() {}
    focus() {}
    click() {}
  }
  function element(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); }
  const filters = ['all','review','done'].map(x => {const e = new Element(x); e.dataset = {filter:x}; return e;});
  const requests = [];
  let fail = false, count = 0;
  const u = {prediction_set:['no'], abstain:false, out_of_scope:false, needs_review:false};
  const context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    performance, Blob, URL,
    document: {getElementById: element, querySelectorAll:()=>filters, addEventListener(){}, createElement:()=>new Element('link')},
    fetch: async (url, options) => {
      requests.push({url, body:options.body ? JSON.parse(options.body) : undefined});
      if (fail && url === '/api/triage') return {ok:false, status:503, json:async()=>({error:'Vega is loading'})};
      let value;
      if (url === '/api/samples') value = samples;
      else if (url === '/api/status') value = {vega:{state:'ready',device:'cuda'},ollama_models:[],backend:'http://127.0.0.1:8770'};
      else if (url === '/api/draft') value = {text:'<img src=x onerror=alert(1)>',provider:'Template (no LLM called)',latency_ms:0};
      else value = {id:String(++count), ticket:JSON.parse(options.body).ticket,
        response:{model:'vega-0.8b',latency_ms:250,answers:{
          team:{choice:'account',probabilities:{technical:.02,billing:.01,account:.95,general:.02},uncertainty:{...u,prediction_set:['account']}},
          urgency:{score:.1,probabilities:{'0':.95,'1':.03,'2':.01,'3':.01},uncertainty:{...u,prediction_set:['0']}},
          escalate:{noul:.01,uncertainty:u},multi_intent:{noul:.01,uncertainty:u}}},
        roundtrip_ms:260,policy:{team:'account',urgency_level:0,disposition:'draft_queue',threshold:JSON.parse(options.body).threshold,confidence:.95,reasons:[]}};
      return {ok:true,json:async()=>value};
    }
  });
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  vm.runInContext(source + '\nglobalThis.hooks={analyze,selectTicket,activeRecord,makeDraft,records};',context);
  return {context, element, requests, filters, fail:()=>{fail=true;}, settle:()=>new Promise(resolve=>setImmediate(resolve))};
}

test('loads samples and reports actual CUDA connection',async()=>{
  const h=harness();await h.settle();
  assert.equal(h.element('connection-text').textContent,'Vega · cuda');
  assert.equal(h.element('ticket-id').textContent,'VD-101');
  assert.match(h.element('inbox').innerHTML,/The whole team is locked out/);
});

test('analysis sends entered ticket and threshold, then renders the actual response',async()=>{
  const h=harness();await h.settle();
  h.element('ticket').value='Please reset my password.';
  assert.equal(await h.context.hooks.analyze(),true);
  assert.deepEqual(h.requests.find(x=>x.url==='/api/triage').body,{ticket:'Please reset my password.',threshold:.8});
  assert.equal(h.element('metric-count').textContent,1);
  assert.match(h.element('decision-result').innerHTML,/Ready for draft queue/);
  assert.match(h.element('decision-result').innerHTML,/250 ms/);
  assert.equal(h.element('analyze').disabled,false);
});

test('editing message or threshold invalidates stale results',async()=>{
  const h=harness();await h.settle();await h.context.hooks.analyze();
  h.element('ticket').value+=' Updated text';h.element('ticket').handlers.input();
  assert.equal(h.context.hooks.activeRecord(),null);
  assert.equal(h.element('decision-result').hidden,true);
});

test('an inference failure is shown and controls are restored',async()=>{
  const h=harness();await h.settle();h.fail();
  assert.equal(await h.context.hooks.analyze(),false);
  assert.equal(h.element('error').textContent,'Vega is loading');
  assert.equal(h.element('error').hidden,false);
  assert.equal(h.element('analyze').disabled,false);
  assert.equal(h.element('decision-loading').hidden,true);
});

test('draft provider output is escaped before rendering',async()=>{
  const h=harness();await h.settle();await h.context.hooks.analyze();
  h.element('draft-provider').value='template';
  await h.context.hooks.makeDraft(h.context.hooks.activeRecord());
  assert.match(h.element('draft-result').innerHTML,/&lt;img/);
  assert.doesNotMatch(h.element('draft-result').innerHTML,/<img/);
});

test('batch runs every sample exactly once and finishes with usable controls',async()=>{
  const h=harness();await h.settle();await h.element('run-all').handlers.click();
  assert.equal(h.requests.filter(x=>x.url==='/api/triage').length,8);
  assert.equal(h.element('metric-count').textContent,8);
  assert.equal(h.element('analyze').disabled,false);
  assert.match(h.element('batch-status').textContent,/8 of 8/);
});

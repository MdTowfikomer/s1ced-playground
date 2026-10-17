'use strict';
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'unavailable';
const duration = value => Number.isFinite(value) ? value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s` : '—';
const urgencyNames = ['Routine', 'Normal', 'High', 'Critical'];
const records = new Map();
const attempts = [];
let samples = [], selected = null, current = null, filter = 'all', busy = false, batch = false, stopBatch = false, health = null;
const modelLabel = () => health?.model?.startsWith('jev-') ? 'Jev' : 'Vega';

async function api(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path === '/api/draft' ? 135000 : 100000);
  try {
    const r = await fetch(path, {signal: controller.signal, ...(body === undefined ? {} : {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)})});
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out. The model may still be processing. Check its terminal, then retry.');
    throw e;
  } finally { clearTimeout(timer); }
}

function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
function threshold() { return Number($('threshold').value) / 100; }
function activeRecord() {
  const r = records.get(selected);
  return r && r.ticket === $('ticket').value.trim() && r.policy.threshold === threshold() ? r : null;
}

function renderInbox() {
  const search = $('search').value.trim().toLowerCase();
  const shown = samples.filter(s => `${s.title} ${s.company} ${s.kind}`.toLowerCase().includes(search))
    .filter(s => filter === 'all' || (filter === 'done' ? records.has(s.id) : records.get(s.id)?.policy.disposition === 'human_review'));
  $('inbox').innerHTML = shown.length ? shown.map(s => {
    const r = records.get(s.id), review = r?.policy.disposition === 'human_review';
    return `<button class="ticket-row ${selected === s.id ? 'selected' : ''}" data-ticket="${escapeHTML(s.id)}" aria-pressed="${selected === s.id}" ${busy || batch ? 'disabled' : ''}><span class="row-top"><span class="mono">${escapeHTML(s.id)}</span><span>${escapeHTML(s.kind)}</span></span><strong>${escapeHTML(s.title)}</strong><span class="row-company">${escapeHTML(s.company)}</span>${r ? `<span class="row-status ${review ? 'review' : ''}"> · ${review ? 'Human review' : 'Draft queue'}</span>` : ''}</button>`;
  }).join('') : '<p class="empty-note">No tickets match this view. Try All or clear your search.</p>';
}

function selectTicket(id) {
  const sample = samples.find(s => s.id === id);
  selected = id;
  $('ticket-id').textContent = sample?.id || 'Your ticket';
  $('ticket-kind').textContent = sample?.kind || 'Custom';
  $('ticket-title').textContent = sample?.title || 'A new customer request';
  $('ticket-company').textContent = sample?.company || 'Paste a real-world scenario or write your own.';
  $('ticket').value = records.get(id)?.ticket || sample?.ticket || '';
  $('char-count').textContent = `${$('ticket').value.length} / 6000`;
  showError(''); renderInbox(); renderResult(activeRecord());
}

function renderMetrics() {
  const values = [...records.values()];
  $('metric-count').textContent = attempts.length;
  $('metric-review').textContent = values.length ? values.filter(r => r.policy.disposition === 'human_review').length : '—';
  $('metric-draft').textContent = values.length ? values.filter(r => r.policy.disposition === 'draft_queue').length : '—';
  const latencies = attempts.map(r => r.response.latency_ms).filter(Number.isFinite).sort((a,b) => a-b);
  const mid = Math.floor(latencies.length         / 2);
  $('metric-latency').textContent = latencies.length ? duration(latencies.length % 2 ? latencies[mid] : (latencies[mid-1] + latencies[mid])/2) : '—';
}

function signals(answer) {
  const u = answer.uncertainty || {};
  return `<div class="signals ${u.needs_review !== false ? 'signal-review' : ''}">Abstain: ${u.abstain == null ? 'unavailable' : u.abstain ? 'yes' : 'no'} · Out of scope: ${u.out_of_scope == null ? 'unavailable' : u.out_of_scope ? 'yes' : 'no'}<br>Prediction set: ${u.prediction_set == null ? 'unavailable' : escapeHTML(u.prediction_set.join(', ') || 'empty')} · Review signal: ${u.needs_review == null ? 'unavailable' : u.needs_review ? 'yes' : 'no'}</div>`;
}

function bars(probs, names = {}) {
  const top = Math.max(...Object.values(probs));
  return Object.entries(probs).map(([key, value]) => `<div class="prob-row ${value === top ? 'top' : ''}"><span>${escapeHTML(names[key] || key)}</span><div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${Number.isFinite(value) ? Math.max(0,Math.min(100,value*100)) : 0}%"></div></div><span>${percent(value)}</span></div>`).join('');
}

function renderResult(record) {
  current = record;
  $('decision-empty').hidden = !!record;
  $('decision-loading').hidden = true;
  $('decision-result').hidden = !record;
  if (!record) return;
  const {policy:p,response:r} = record, a = r.answers, review = p.disposition === 'human_review';
  const sample = samples.find(s => s.id === selected);
  const expected = sample?.ticket === record.ticket ? sample.expected : null;
  const predictions = {team: p.team, urgency: p.urgency_level, escalate: a.escalate.noul >= .5, multi_intent: a.multi_intent.noul >= .5};
  const checks = expected ? Object.entries(expected).filter(([,v]) => v !== null).map(([key,v]) => `${key}: ${predictions[key] === v ? 'matches' : 'differs from'} expected ${String(v)}`) : [];
  $('decision-result').innerHTML = `
    <div class="outcome ${review ? 'review' : ''}"><span class="outcome-label">${review ? 'Human review required' : 'Ready for draft queue'}</span><h3>${escapeHTML(p.team[0].toUpperCase()+p.team.slice(1))} · ${urgencyNames[p.urgency_level]}</h3><p>${review ? 'The policy keeps this ticket with a human. No automatic resolution.' : 'All four decisions clear the threshold and review checks. A reply still needs approval.'}</p></div>
    <div class="trace-meta"><span>${escapeHTML(r.model)} · ${duration(r.latency_ms)}</span><span>Round trip ${duration(record.roundtrip_ms)}</span></div>
    <section class="question"><div class="question-title"><span>01 · Which team?</span><span class="question-tag">choice</span></div>${bars(a.team.probabilities)}${signals(a.team)}</section>
    <section class="question"><div class="question-title"><span>02 · How urgent?</span><span class="question-tag">score 0–3</span></div>${bars(a.urgency.probabilities,Object.fromEntries(urgencyNames.map((x,i)=>[String(i),x])))}<div class="signals">Expected score: ${Number(a.urgency.score).toFixed(2)} / 3. Policy uses the most likely level.</div>${signals(a.urgency)}</section>
    <section class="question"><div class="question-title"><span>03 · Specialist escalation?</span><span class="question-tag">yes / no</span></div>${bars({yes:a.escalate.noul,no:1-a.escalate.noul})}${signals(a.escalate)}</section>
    <section class="question"><div class="question-title"><span>04 · Multiple requests?</span><span class="question-tag">yes / no</span></div>${bars({yes:a.multi_intent.noul,no:1-a.multi_intent.noul})}${signals(a.multi_intent)}</section>
    <section class="reasons"><h3>Why this next step?</h3>${p.reasons.length ? `<ul>${p.reasons.map(reason=>`<li>${escapeHTML(reason)}</li>`).join('')}</ul>` : '<p>No blocking signals were reported. Low urgency, no specialist escalation, and every answer meets your confidence threshold.</p>'}<p>Lowest decision confidence: <strong>${percent(p.confidence)}</strong>. Policy threshold: ${percent(p.threshold)}.</p>${(p.notes || []).map(n=>`<p>${escapeHTML(n)}</p>`).join('')}</section>
    <section class="draft-box"><h3>Next: prepare a reply for review</h3><div class="draft-controls"><label class="sr-only" for="draft-provider">Drafting model</label><select id="draft-provider"><option value="template">Template · no LLM</option>${(health?.ollama_models || []).map(m=>`<option value="${escapeHTML(m)}">Ollama · ${escapeHTML(m)}</option>`).join('')}</select><button id="make-draft">Prepare draft</button></div><p class="draft-meta">${health?.ollama_models?.length ? 'Optional System 2: a generative model writes after Vega decides.' : 'Start Ollama with an installed model, then refresh the connection to enable LLM drafting.'} Nothing is sent.</p><div id="draft-result" aria-live="polite"></div></section>
    ${checks.length ? `<details><summary>Compare with authored demo expectations</summary><p class="expected">${checks.map(escapeHTML).join('<br>')}<br>These labels illustrate behavior; eight hand-written examples do not establish model accuracy.</p></details>` : ''}
    <details><summary>Inspect request, model response, and policy</summary><pre>${escapeHTML(JSON.stringify(record,null,2))}</pre></details>
    <div class="result-actions"><button id="export" class="text-button">Download result JSON ↓</button><span class="draft-meta">Actual response, no simulated scores</span></div>`;
  $('make-draft').addEventListener('click', () => makeDraft(record));
  $('export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href=url; link.download=`vega-desk-${record.id}.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
}

async function makeDraft(record) {
  const button = $('make-draft'), output = $('draft-result'), value = $('draft-provider').value;
  button.disabled = true; button.textContent='Preparing…'; output.textContent='';
  try {
    const draft = await api('/api/draft',{id:record.id, provider:value === 'template' ? 'template' : 'ollama', model:value});
    output.innerHTML=`<div class="draft-text">${escapeHTML(draft.text)}</div><div class="draft-meta">${escapeHTML(draft.provider)} · ${duration(draft.latency_ms)} · Unsent draft. Review before use.</div>`;
  } catch(e) { output.textContent=e.message; }
  finally { button.disabled=false; button.textContent='Prepare draft'; }
}

function setBusy(value) {
  busy = value;
  $('ticket').disabled=value || batch; $('threshold').disabled=value || batch; $('new-ticket').disabled=value || batch;
  $('analyze').disabled=value || batch; $('analyze').textContent=value ? `Analyzing with ${modelLabel()}…` : `Analyze with ${modelLabel()} →`;
  $('decision-panel').setAttribute('aria-busy',String(value));
  renderInbox();
}

async function analyze() {
  if (busy) return false;
  if (!$('ticket').value.trim()) { showError('Enter a customer message first.'); $('ticket').focus(); return false; }
  const id = selected, ticket = $('ticket').value.trim();
  showError(''); setBusy(true); $('decision-empty').hidden=true; $('decision-result').hidden=true; $('decision-loading').hidden=false;
  $('elapsed').textContent='0.0 s'; const start=performance.now();
  const interval=setInterval(()=>{$('elapsed').textContent=`${((performance.now()-start)/1000).toFixed(1)} s`;},100);
  try {
    const result=await api('/api/triage',{ticket,threshold:threshold()});
    records.set(id,result); attempts.push(result); renderMetrics(); renderResult(result); return true;
  } catch(e) { showError(e.message); renderResult(activeRecord()); return false; }
  finally { clearInterval(interval); setBusy(false); }
}

async function refreshStatus() {
  $('refresh').disabled=true;
  try {
    health=await api('/api/status'); const v=health.decision_model || health.vega;
    const available = ['ready','configured'].includes(v.state);
    $('connection-text').textContent=available ? `${modelLabel()} · ${v.device || 'device unknown'}` : `${modelLabel()} · ${v.state}`;
    $('refresh').classList.toggle('offline',!available);
    $('refresh').title=v.error || `Model API: ${health.backend}. Refresh connection.`;
    document.querySelectorAll('[data-model-name]').forEach(el=>{el.textContent=modelLabel();});
    if(!busy) $('analyze').textContent=`Analyze with ${modelLabel()} →`;
    const privacy = $('privacy-note');
    if(privacy) privacy.textContent=modelLabel() === 'Jev' ? 'Tickets are sent to TypeSafe’s hosted Jev API when analyzed. No replies are sent.' : 'Model inference runs on your computer. No replies are sent.';
    if (current && !busy) renderResult(current);
  } catch(e) { $('connection-text').textContent='Demo server offline'; $('refresh').classList.add('offline'); $('refresh').title=e.message; }
  finally { $('refresh').disabled=false; }
}

$('inbox').addEventListener('click',e=>{const button=e.target.closest('[data-ticket]'); if(button && !busy && !batch)selectTicket(button.dataset.ticket);});
$('search').addEventListener('input',renderInbox);
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{
  filter=b.dataset.filter; document.querySelectorAll('[data-filter]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));});renderInbox();
}));
$('new-ticket').addEventListener('click',()=>{selectTicket(`custom-${Date.now()}`);$('ticket').focus();});
$('ticket').addEventListener('input',()=>{$('char-count').textContent=`${$('ticket').value.length} / 6000`;renderResult(activeRecord());showError('');});
$('threshold').addEventListener('input',()=>{$('threshold-value').textContent=`${$('threshold').value}%`;renderResult(activeRecord());});
$('analyze').addEventListener('click',()=>{if(!batch)analyze();});
$('refresh').addEventListener('click',refreshStatus);
document.addEventListener('keydown',e=>{if((e.ctrlKey || e.metaKey) && e.key==='Enter' && !busy && !batch){e.preventDefault();analyze();}});
$('run-all').addEventListener('click',async()=>{
  if(batch){stopBatch=true;$('run-all').textContent='Stopping after this ticket…';return;}
  if(busy)return;
  batch=true;stopBatch=false;$('run-all').textContent='Stop after current ticket';
  let completed=0;
  for(const sample of samples){
    if(stopBatch)break;
    selectTicket(sample.id);$('ticket').value=sample.ticket;
    $('batch-status').textContent=`Analyzing ${completed+1} of ${samples.length}: ${sample.title}`;
    const ok=await analyze();if(!ok)break;completed++;
  }
  batch=false;setBusy(false);$('run-all').textContent='Run sample inbox ↗';
  $('batch-status').textContent=`Batch finished: ${completed} of ${samples.length} tickets analyzed.`;
});

async function initialize(){
  try{samples=await api('/api/samples');$('sample-count').textContent=`${samples.length} tickets`;$('nav-count').textContent=samples.length;selectTicket(samples[0].id);}
  catch(e){showError(e.message);$('inbox').innerHTML='<p class="empty-note">Samples could not load. Refresh the page to retry, or write your own ticket.</p>';}
  await refreshStatus();
}
initialize();

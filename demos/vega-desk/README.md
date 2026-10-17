# Vega Desk

A small support-operations demo showing how a System 1 decision model fits into an application. It reuses your running Vega model. No extra packages, API keys, or model downloads are required for the demo server.

## Start

### Jev (now the default)

The demo defaults to `jev-latest`. Its hosted base URL is `https://api.typesafe.ai`, and the decision endpoint is `POST /v1/systemone` with `Authorization: Bearer <full key>` (https://docs.typesafe.ai/api). Do not put API keys in source files or chat.

1. Open the existing playground at http://127.0.0.1:8770 and use **Add key** to enter the full TypeSafe API key. The server validates it and holds it outside the browser. Remembering the key is optional.
2. Start the demo: `python demos/vega-desk/server.py --model jev-latest`.
3. Open http://127.0.0.1:8780 and refresh the connection. `Jev · hosted API` means a key is configured, not that a paid inference call has been verified.

Analyzing tickets now sends their contents to TypeSafe's hosted API and uses the account's paid API credits. The demo uses the existing playground as a local proxy; keep `--backend http://127.0.0.1:8770`, rather than setting that option to TypeSafe's URL.

Alternatively, paste the full key into the repository-root `.env` file as `TYPESAFE_API_KEY=your_full_key`. The demo reads it on each request, so saving the file and refreshing the connection is enough. This file is git-ignored. An existing `TYPESAFE_API_KEY` environment variable takes precedence. The key is passed server-to-server to the playground, never included in browser responses or result downloads. Keep the playground running; it forwards the key to TypeSafe when no server key is already configured.

Jev does not report Vega's abstention/prediction-set signals. They remain unavailable in the trace. The Jev policy checks confidence and explicit high-urgency/escalation rules instead of interpreting unavailable flags as automatic review. It also displays a note explaining this difference. Vega retains its original conservative policy.

To return to local Vega: `python demos/vega-desk/server.py --model vega-0.8b`. The walkthrough and original evaluation below describe that Vega mode.

### Local Vega

Keep the playground running on port 8770 with Vega ready on CUDA. In a **second terminal**, from the repository root:

```powershell
python demos/vega-desk/server.py --model vega-0.8b
```

Open **http://127.0.0.1:8780**. Stop this demo with Ctrl+C. The model playground stays running independently.

If your playground uses another port:

```powershell
python demos/vega-desk/server.py --backend http://127.0.0.1:9000
```

`--model vega-4b` requires that model to be available in the playground. The health badge reflects the playground's selected Vega model; the trace always identifies the model that actually answered.

## A five-minute walkthrough

1. Analyze **The whole team is locked out**. Show the team probabilities, urgency distribution, and explicit escalation prediction.
2. Analyze **Login, billing, and an invoice**. Show the yes/no probability for multiple requests.
3. Analyze **The issue needs another look**. Show how incomplete evidence produces uncertainty and a human-review path.
4. Change the confidence slider and rerun. Thresholds are application policy. Lowering one never bypasses the model's abstention or out-of-scope signals.
5. Prepare a reply. The default is explicitly labeled **Template (no LLM called)**. Open the JSON to distinguish the model's predictions from the application's policy and draft.
6. Run the whole sample inbox. Session metrics report measured latency, completed inference calls, and the latest queue assignment per ticket. Download any result as JSON.

Nothing sends an email, issues a refund, or closes a ticket. Customer text and outputs are held in memory; there is no database. Refreshing the browser resets the displayed session. At most 200 records are retained in server memory for drafting. Model servers may have their own retention behavior.

## What Vega does

One request to `POST /v1/systemone` asks four questions:

| Question | Type | Output |
| --- | --- | --- |
| Owning team | `choice` | Distribution over technical, billing, account, general |
| Urgency | `score` | Distribution over 0–3 plus expected score |
| Specialist escalation | `noul` | Probability of yes |
| Multiple requests | `noul` | Probability of yes |

Each answer retains the original `prediction_set`, `abstain`, `out_of_scope`, and `needs_review` signals. Latency comes directly from the model response; round-trip time also includes the local HTTP and policy work. A probability is not a guarantee of correctness.

The deterministic policy sends the ticket for human review if **any** answer abstains, is out of scope, has a non-singleton prediction set, lacks a clear negative review flag, or falls below the selected confidence threshold. High/critical urgency, escalation, multiple requests, and upstream warnings also trigger review. Binary confidence is `max(p(yes), 1-p(yes))`. Urgency policy uses the most likely level rather than rounding its expected score. See `apply_policy` in `server.py`.

Only when every check passes does the ticket enter a draft queue. A draft always remains unsent. Missing or malformed outputs never silently become permission to automate.

## Optional System 2: an LLM writes the draft

The core demo works with Vega alone. For a real generative step, run Ollama with a locally installed text model. Refresh the connection in Vega Desk and select that model in the drafting dropdown. The app discovers installed models via `/api/tags`, then sends a separate, explicit call to `/api/generate` with `stream: false`. No models are automatically installed.

Vega makes structured decisions; the LLM writes an acknowledgement using those decisions as context. It cannot overwrite the displayed policy. Drafts require human review, including any generated promises or unsupported statements. The optional LLM path is covered with a mocked provider test; no Ollama instance was running during the live Vega checks.

Ollama API reference: https://github.com/ollama/ollama/blob/main/docs/api.md

## Source and honest limits

The supplied `System_One_Use_Cases.xlsx` contains 100 scenarios. This demo combines ideas #51 (multiple support requests), #52 (complaint escalation), #53 (SLA routing), #55 (billing disputes), #58 (knowledge-base mismatch), and #60 (bug reproducibility). `samples.json` records each example's origin; the routine and ambiguous controls were authored for this demo. The spreadsheet is not needed at runtime and was not modified.

Expected labels are hand-written demonstrations, not independently verified benchmark labels. Some examples intentionally have no single expected team or urgency. The app exposes mismatches rather than hiding them.

In an initial live run on the existing RTX 3050 CUDA server, eight samples took about **193–512 ms of model time per four-question request**. All eight went to human review under the default 80% policy. Vega did not reliably distinguish all team/urgency labels, and some questions were marked out of scope. This is a useful demonstration of uncertainty handling, not evidence that this model is ready to automate support. Do not remove abstention checks just to make a demo produce more automatic routes. Hardware, warmup, and prompt changes affect timing.

## Verify

```powershell
python -m unittest discover -s demos/vega-desk -p test_*.py
node --check demos/vega-desk/app.js
node --test demos/vega-desk/app.test.cjs
```

The Python tests use synthetic model outputs and a local HTTP test server, with no dependency on PyTorch or downloaded weights. They exercise conservative review routing, low-confidence negative predictions, threshold boundaries, malformed inputs, source-model identity, draft generation, and origin checks. JavaScript tests exercise initialization, inference, stale-result invalidation, failure recovery, escaping, and batch progression through a DOM adapter. They do not establish visual or real-browser behavior. Browser automation was unavailable during development. Live Vega checks are separate from those tests.

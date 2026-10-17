"""Run: python -m unittest discover -s demos/vega-desk -p test_*.py"""
import json
import math
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

import server


def answer():
    clear = {'prediction_set': ['no'], 'abstain': False, 'out_of_scope': False, 'needs_review': False}
    return {'model': 'vega-0.8b', 'warnings': [], 'usage': {'input_tokens': 30, 'output_tokens': 0}, 'latency_ms': 20,
            'answers': {
                'team': {'type': 'choice', 'choice': 'account', 'confidence': .95,
                         'probabilities': {'technical': .02, 'billing': .01, 'account': .95, 'general': .02},
                         'uncertainty': {**clear, 'prediction_set': ['account']}},
                'urgency': {'type': 'score', 'score': .1, 'confidence': .95,
                            'probabilities': {'0': .95, '1': .03, '2': .01, '3': .01},
                            'uncertainty': {**clear, 'prediction_set': ['0']}},
                'escalate': {'type': 'noul', 'noul': .01, 'uncertainty': dict(clear)},
                'multi_intent': {'type': 'noul', 'noul': .01, 'uncertainty': dict(clear)}}}


class PolicyTests(unittest.TestCase):
    def test_env_file_key_is_read_without_loading_other_variables(self):
        with patch.dict(server.os.environ, {'TYPESAFE_API_KEY': ''}), \
             patch.object(server.Path, 'exists', return_value=True), \
             patch.object(server.Path, 'read_text', return_value='# comment\nTYPESAFE_API_KEY="test-only-value"\nOTHER=ignored'):
            self.assertEqual(server.read_api_key(), 'test-only-value')

    def test_environment_key_takes_precedence_over_file(self):
        with patch.dict(server.os.environ, {'TYPESAFE_API_KEY': 'test-env-value'}), \
             patch.object(server.Path, 'read_text', side_effect=AssertionError('must not read file')):
            self.assertEqual(server.read_api_key(), 'test-env-value')

    def test_clear_low_risk_ticket_can_enter_draft_queue(self):
        self.assertEqual(server.apply_policy(answer(), .8)['disposition'], 'draft_queue')

    def test_jev_unavailable_uncertainty_uses_explicit_confidence_policy(self):
        out = answer(); out['model'] = 'jev-1.13.0'
        for a in out['answers'].values():
            a['uncertainty'] = dict.fromkeys(['prediction_set', 'abstain', 'out_of_scope', 'needs_review'])
        policy = server.apply_policy(out, .8)
        self.assertEqual(policy['disposition'], 'draft_queue')
        self.assertIn('does not report abstention', policy['notes'][0])
        out['answers']['escalate']['noul'] = .99
        self.assertEqual(server.apply_policy(out, .8)['disposition'], 'human_review')

    def test_confident_no_uses_one_minus_probability(self):
        out = server.apply_policy(answer(), .8)
        self.assertEqual(out['confidences']['escalate'], .99)

    def test_threshold_boundary_and_raising_threshold(self):
        self.assertEqual(server.apply_policy(answer(), .95)['disposition'], 'draft_queue')
        self.assertEqual(server.apply_policy(answer(), .96)['disposition'], 'human_review')

    def test_uncertainty_cannot_be_overridden_by_lowering_threshold(self):
        for change in ({'abstain': True}, {'out_of_scope': True}, {'needs_review': True},
                       {'needs_review': None}, {'prediction_set': []}, {'prediction_set': ['yes', 'no']}):
            with self.subTest(change=change):
                out = answer()
                out['answers']['team']['uncertainty'].update(change)
                self.assertEqual(server.apply_policy(out, .5)['disposition'], 'human_review')

    def test_missing_uncertainty_requires_review(self):
        out = answer(); del out['answers']['team']['uncertainty']
        self.assertEqual(server.apply_policy(out, .8)['disposition'], 'human_review')

    def test_high_urgency_requires_review(self):
        out = answer(); out['answers']['urgency']['probabilities'] = {'0': .01, '1': .01, '2': .96, '3': .02}
        self.assertEqual(server.apply_policy(out, .8)['disposition'], 'human_review')

    def test_yes_to_escalation_or_multiple_intents_requires_review(self):
        for qid in ('escalate', 'multi_intent'):
            out = answer(); out['answers'][qid]['noul'] = .99
            self.assertEqual(server.apply_policy(out, .8)['disposition'], 'human_review')

    def test_ambiguous_no_is_not_auto_routed(self):
        out = answer(); out['answers']['escalate']['noul'] = .49
        self.assertEqual(server.apply_policy(out, .8)['disposition'], 'human_review')

    def test_warnings_require_review(self):
        out = answer(); out['warnings'] = ['Input shortened']
        self.assertEqual(server.apply_policy(out, .8)['disposition'], 'human_review')

    def test_malformed_answer_is_not_silently_accepted(self):
        for mutation in ('missing', 'bad_probability', 'bad_team', 'bad_urgency'):
            out = answer()
            if mutation == 'missing': del out['answers']['escalate']
            elif mutation == 'bad_probability': out['answers']['escalate']['noul'] = math.nan
            elif mutation == 'bad_team': out['answers']['team']['choice'] = 'invented'
            else: out['answers']['urgency']['probabilities'] = {}
            with self.subTest(mutation=mutation), self.assertRaises(server.APIError):
                server.apply_policy(out, .8)

    def test_invalid_input_rejected(self):
        for body in ([], {}, {'ticket': ''}, {'ticket': 9}, {'ticket': 'x' * 6001},
                     {'ticket': 'x', 'threshold': math.nan}, {'ticket': 'x', 'threshold': True},
                     {'ticket': 'x', 'threshold': .1}):
            with self.subTest(body=str(body)[:80]), self.assertRaises(server.APIError):
                server.validate_input(body)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        key_reader = patch.object(server, 'read_api_key', return_value='')
        key_reader.start()
        self.addCleanup(key_reader.stop)

    @classmethod
    def setUpClass(cls):
        args = SimpleNamespace(backend='http://127.0.0.1:8770', ollama='http://127.0.0.1:11434', model='vega-0.8b')
        cls.srv = ThreadingHTTPServer(('127.0.0.1', 0), server.make_handler(args))
        cls.srv.daemon_threads = True
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.srv.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close(); cls.thread.join()

    def call(self, path, data=None, headers=None):
        raw = json.dumps(data).encode() if data is not None else None
        req = Request(self.url + path, data=raw, headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            with urlopen(req, timeout=4) as response:
                return response.status, json.load(response)
        except HTTPError as exc:
            return exc.code, json.load(exc)

    def test_real_http_triage_then_template_draft(self):
        with patch.object(server, 'request_json', return_value=answer()) as upstream:
            status, result = self.call('/api/triage', {'ticket': 'Please help reset my password.', 'threshold': .8})
        self.assertEqual(status, 200)
        self.assertEqual(upstream.call_args.args[1]['model'], 'vega-0.8b')
        self.assertEqual(set(upstream.call_args.args[1]['questions']), set(server.QUESTIONS))
        self.assertEqual(result['policy']['disposition'], 'draft_queue')
        status, draft = self.call('/api/draft', {'id': result['id'], 'provider': 'template'})
        self.assertEqual(status, 200); self.assertFalse(draft['sent']); self.assertIn('no LLM', draft['provider'])

    def test_draft_uses_server_record_not_client_supplied_policy(self):
        status, data = self.call('/api/draft', {'id': 'forged', 'policy': {'team': 'billing'}})
        self.assertEqual(status, 404)

    def test_model_errors_preserve_status_and_message(self):
        with patch.object(server, 'request_json', side_effect=server.APIError(503, 'Vega is loading')):
            status, data = self.call('/api/triage', {'ticket': 'Hello'})
        self.assertEqual((status, data['error']), (503, 'Vega is loading'))

    def test_substitute_model_is_rejected(self):
        response = answer(); response['model'] = 's1ced'
        with patch.object(server, 'request_json', return_value=response):
            status, _ = self.call('/api/triage', {'ticket': 'Hello'})
        self.assertEqual(status, 502)

    def test_cross_origin_calls_are_blocked(self):
        self.assertEqual(self.call('/api/triage', {'ticket': 'Hello'}, {'Origin': 'https://example.com'})[0], 403)

    def test_non_object_json_and_empty_ticket_are_rejected(self):
        for body in ([], {'ticket': ''}):
            self.assertEqual(self.call('/api/triage', body)[0], 400)

    def test_ollama_draft_is_separate_from_vega_inference(self):
        with patch.object(server, 'request_json', return_value=answer()):
            _, result = self.call('/api/triage', {'ticket': 'Hello'})
        with patch.object(server, 'request_json', side_effect=[{'models': [{'name': 'local-test'}]}, {'response': 'Thanks for the report.'}]) as llm:
            status, draft = self.call('/api/draft', {'id': result['id'], 'provider': 'ollama', 'model': 'local-test'})
        self.assertEqual(status, 200); self.assertEqual(draft['text'], 'Thanks for the report.')
        self.assertFalse(draft['sent']); self.assertEqual(llm.call_args.args[1]['stream'], False)

    def test_sample_assets_are_valid(self):
        status, samples = self.call('/api/samples')
        self.assertEqual(status, 200); self.assertEqual(len(samples), 8)
        self.assertEqual(len({s['id'] for s in samples}), 8)
        for s in samples:
            server.validate_input({'ticket': s['ticket']})


if __name__ == '__main__':
    unittest.main()

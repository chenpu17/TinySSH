from pathlib import Path
import json,statistics
root=Path('/Users/chenpu/workspace/claude-code/TinySSH')
raw=root/'docs/acceptance/ux-r1/g0/2026-10-06-7c4502e/raw'
def read(name):return json.loads((raw/name).read_text())
def stats(xs):return {'n':len(xs),'median':statistics.median(xs),'p95_inclusive':statistics.quantiles(xs,n=20,method='inclusive')[18]}
out={}
for name in ['cold','warm','cold_retry']:
 d=read(name+'.json');out[name]={'stored_runs':stats([r['operable_ms'] for r in d['runs']]),'s2_minus_700':stats([r['s2_ms']-700 for r in d['runs']]),'summary':d['operable']}
p3=read('p3.json');out['p3_timing']=stats([r['total_ms'] for r in p3['runs'] if 'total_ms'in r]);out['p3_run_keys']=list(p3['runs'][0])
p6=read('p6_cycles.json');rr=[r for r in p6['runs'] if 'rss_mb'in r];out['p6']={'n':len(rr),'first10_median':statistics.median(r['rss_mb']for r in rr[:10]),'last10_median':statistics.median(r['rss_mb']for r in rr[-10:]),'nonempty_residue':sum(bool(r.get('residue_pids'))for r in rr),'distinct_pids_present':all('pid' in r for r in rr)}
p5=read('p5_pilot.json');b=statistics.median(p5['B_samples']);e=statistics.median(p5['E_samples']);tail=statistics.median(p5['E_samples'][-4:]);out['p5']={'B':b,'E':e,'growth_pct':(e-b)/b*100,'tail_E':tail,'tail_growth_pct':(tail-b)/b*100}
# Independent, pure reproductions of the selectors/sets in the reviewed scripts.
failure='[app] autoconnect test-host failed: authentication failed'
out['failure_log_selector_probe']={'line':failure,'script_substring_matches':'autoconnect' in failure}
s0={101};frozen={202};during={101:1000,303:6000};after={101:1000}
out['helper_replacement_probe']={'frozen_candidate_pids':sorted(frozen),'during_helpers':during,'counted_helper_rss':sum(during.get(p,0)for p in frozen),'new_helper_omitted':303 not in frozen,'exit_check_reports_no_residue':not(frozen & set(after))}
out['keyguard_wrong_instance_probe']={'frontmost_name':'tinyssh-app','onscreen_same_name_1280x800':True,'test_pid':999,'frontmost_pid':888,'current_guard_accepts':True,'reason':'verify accepts name/window dimensions; does not consume the test pid'}
Path('/tmp/tinyssh-g0-decision-review/evidence-results.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(out,ensure_ascii=False,indent=2))

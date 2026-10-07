import glob
import os
import subprocess
import sys

deps_dir = os.path.abspath('target/debug/deps')

sublegos = [
    ('L11.S01', 'lego/L11-future-platform/S01-event-automation-control/implementation/mod.rs'),
    ('L11.S02', 'lego/L11-future-platform/S02-execution-side-effect-reliability/implementation/mod.rs'),
    ('L11.S03', 'lego/L11-future-platform/S03-advanced-scheduler-intelligence/implementation/mod.rs'),
    ('L11.S04', 'lego/L11-future-platform/S04-worker-distributed-extensions/implementation/mod.rs'),
    ('L11.S05', 'lego/L11-future-platform/S05-storage-lifecycle-dr-extensions/implementation/mod.rs'),
    ('L11.S06', 'lego/L11-future-platform/S06-operator-edge-control-plane/implementation/mod.rs'),
    ('L11.S07', 'lego/L11-future-platform/S07-ecosystem-interoperability/implementation/mod.rs'),
    ('L11.S08', 'lego/L11-future-platform/S08-advanced-agent-ai-optimization/implementation/mod.rs'),
]

overall_pass = True
total_tests_passed = 0

print("=" * 70)
print("           L11 SUB-LEGO UNIT & DOMAIN TEST EXECUTION")
print("=" * 70)

for s_id, mod_path in sublegos:
    tag = s_id.lower().replace('.', '_')
    exe_name = os.path.join('target', 'debug', f'test_{tag}.exe')
    cmd = ['rustc', '--edition', '2021', '--test', mod_path, '-L', f'dependency={deps_dir}', '-o', exe_name]

    for p in glob.glob(os.path.join(deps_dir, '*.dll')):
        base = os.path.basename(p)
        crate_name = base.split('-')[0]
        cmd.extend(['--extern', f'{crate_name}={p}'])

    for name in ['serde', 'serde_json', 'thiserror']:
        matches = glob.glob(os.path.join(deps_dir, f'lib{name}-*.rlib'))
        if matches:
            cmd.extend(['--extern', f'{name}={matches[0]}'])

    c_res = subprocess.run(cmd, capture_output=True, text=True)
    if c_res.returncode != 0:
        print(f"[{s_id}] COMPILE FAILED:\n{c_res.stderr}")
        overall_pass = False
        continue

    t_res = subprocess.run([exe_name], capture_output=True, text=True)
    lines = [line for line in t_res.stdout.splitlines() if 'test result:' in line]
    summary = lines[0] if lines else 'No summary'
    print(f"[{s_id}] {summary} (Exit code: {t_res.returncode})")
    if t_res.returncode != 0:
        overall_pass = False
        print(t_res.stdout)
        print(t_res.stderr)
    else:
        # Extract passed count
        if "passed;" in summary:
            count = int(summary.split("passed;")[0].split()[-1])
            total_tests_passed += count

print("=" * 70)
print(f"OVERALL L11 UNIT TEST RESULT: {'PASS' if overall_pass else 'FAIL'}")
print(f"TOTAL L11 UNIT TESTS PASSED : {total_tests_passed}")
print("=" * 70)

sys.exit(0 if overall_pass else 1)

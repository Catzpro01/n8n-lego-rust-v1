import sys
import json
import urllib.request
import urllib.error
import subprocess
import time

def run_regression_gate():
    print("=== [AGENT 5] RUNNING INTEGRATION & REGRESSION GATE ===")
    
    passed_checks = 0
    total_checks = 5

    # Check 1: Healthz
    try:
        req = urllib.request.Request("http://127.0.0.1:5678/healthz")
        with urllib.request.urlopen(req, timeout=5) as res:
            if res.status == 200:
                print("[PASS] 1/5 n8n process is healthy (HTTP 200)")
                passed_checks += 1
            else:
                print(f"[FAIL] 1/5 Healthz returned status {res.status}")
    except Exception as e:
        print(f"[FAIL] 1/5 Healthz check failed: {e}")

    # Check 2: Editor UI
    try:
        req = urllib.request.Request("http://127.0.0.1:5678/")
        with urllib.request.urlopen(req, timeout=5) as res:
            body = res.read().decode("utf-8", errors="replace")
            if res.status == 200 and "n8n" in body:
                print("[PASS] 2/5 n8n Editor UI is accessible")
                passed_checks += 1
            else:
                print(f"[FAIL] 2/5 Editor UI returned invalid response")
    except Exception as e:
        print(f"[FAIL] 2/5 Editor UI check failed: {e}")

    # Check 3: Webhook Execution
    payload = json.dumps({"test": "regression_gate", "sender": "agent-5"}).encode()
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:5678/webhook/smoke-test",
            data=payload,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            res_data = json.loads(res.read().decode("utf-8"))
            if res_data.get("smoke_test") == "PASS":
                print("[PASS] 3/5 Live Webhook execution returned PASS")
                passed_checks += 1
            else:
                print(f"[FAIL] 3/5 Webhook output mismatch: {res_data}")
    except Exception as e:
        print(f"[FAIL] 3/5 Webhook call failed: {e}")

    # Check 4: Database Execution Recording
    try:
        cmd = ["docker", "exec", "n8n-db-1", "psql", "-U", "n8n", "-d", "n8n", "-t", "-A", "-c", "SELECT status FROM execution_entity ORDER BY id DESC LIMIT 1;"]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        last_status = proc.stdout.strip()
        if last_status == "success":
            print("[PASS] 4/5 Latest execution recorded in PostgreSQL with status 'success'")
            passed_checks += 1
        else:
            print(f"[FAIL] 4/5 DB execution status mismatch: '{last_status}'")
    except Exception as e:
        print(f"[FAIL] 4/5 DB check failed: {e}")

    # Check 5: Contract Boundary Check
    try:
        import os
        contracts = ["workflow.contract.md", "node.contract.md", "connection.contract.md", "validation.contract.md"]
        all_contracts_ok = True
        for c in contracts:
            if not os.path.exists(f"contracts/{c}"):
                all_contracts_ok = False
                break
        if all_contracts_ok:
            print("[PASS] 5/5 LEGO Contracts present and verified")
            passed_checks += 1
        else:
            print("[FAIL] 5/5 One or more contract definitions missing")
    except Exception as e:
        print(f"[FAIL] 5/5 Contract check failed: {e}")

    print("-------------------------------------------------------")
    print(f"GATE RESULT: {passed_checks}/{total_checks} CHECKS PASSED")

    if passed_checks == total_checks:
        print(">>> INTEGRATION GATE: PASS (Safe to Merge) <<<")
        return 0
    else:
        print(">>> INTEGRATION GATE: FAIL (Regression Detected - Merge Rejected) <<<")
        return 1

if __name__ == "__main__":
    sys.exit(run_regression_gate())

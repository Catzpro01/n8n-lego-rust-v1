#!/usr/bin/env python3
"""
Test WAL Fail-Closed CLI Verification Script.
Memastikan binary CLI n8n-rust-app keluar dengan exit code 1 dan memancarkan JSON error
ketika konfigurasi path WAL tidak valid atau tidak dapat diinisialisasi secara durable.
"""

import os
import sys
import json
import subprocess
from pathlib import Path

def run_wal_fail_closed_test():
    repo_root = Path(__file__).resolve().parent.parent.parent
    binary_path = repo_root / "apps" / "n8n-rust" / "target" / "debug" / "n8n-rust-app.exe"
    
    if not binary_path.exists():
        print(f"[FAIL] Binary tidak ditemukan di: {binary_path}")
        sys.exit(1)
        
    print(f"[INFO] Menguji binary CLI: {binary_path}")
    
    workflow_payload = {
        "executionId": "test_wal_fail_closed_exec_001",
        "mode": "manual",
        "workflow": {
            "id": "wf_test_wal_fail_closed",
            "name": "Fail Closed Test Workflow",
            "active": True,
            "nodes": [
                {
                    "id": "node_1",
                    "name": "Set Test",
                    "typeVersion": 1.0,
                    "type": "n8n-nodes-base.set",
                    "position": [0.0, 0.0],
                    "parameters": {
                        "testKey": "testVal"
                    }
                }
            ],
            "connections": {}
        }
    }
    input_json = json.dumps(workflow_payload)

    # Uji 1: N8N_WAL_DIR menunjuk ke drive/path yang mustahil dibuat (Z:\invalid_drive_wal\...)
    invalid_wal_dir = r"Z:\invalid_path_fail_closed_never_exists\wal"
    env = os.environ.copy()
    env["N8N_WAL_DIR"] = invalid_wal_dir

    print(f"[TEST 1] Menjalankan binary dengan N8N_WAL_DIR invalid: {invalid_wal_dir}")
    proc = subprocess.Popen(
        [str(binary_path), "execute"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env
    )
    stdout, stderr = proc.communicate(input=input_json, timeout=10)
    exit_code = proc.returncode

    print(f"  -> Exit Code : {exit_code}")
    print(f"  -> Stdout    : {stdout.strip()}")
    print(f"  -> Stderr    : {stderr.strip()}")

    # Validasi 1: Exit code harus tepat 1
    assert exit_code == 1, f"Expected exit code 1, but got {exit_code}"
    print("  [PASS] Exit code adalah 1 (fail-closed)")

    # Validasi 2: Stdout harus berupa format JSON error yang valid
    try:
        err_json = json.loads(stdout.strip())
    except json.JSONDecodeError as e:
        raise AssertionError(f"Stdout bukan valid JSON: {stdout}") from e

    assert err_json.get("status") == "error", f"Expected status == 'error', got {err_json.get('status')}"
    assert "error" in err_json, "Expected 'error' field in JSON response"
    assert "WAL" in err_json["error"] or "wal" in err_json["error"].lower(), f"Expected WAL mentioned in error: {err_json['error']}"
    print("  [PASS] Output JSON error valid:", err_json)

    # Uji 2: Flag --ipc dengan path karakter ilegal Windows
    illegal_wal_dir = r"C:\invalid*?<>|:\wal"
    env["N8N_WAL_DIR"] = illegal_wal_dir
    print(f"\n[TEST 2] Menjalankan binary dengan path ilegal di Windows: {illegal_wal_dir}")
    proc2 = subprocess.Popen(
        [str(binary_path), "--ipc"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env
    )
    stdout2, stderr2 = proc2.communicate(input=input_json, timeout=10)
    exit_code2 = proc2.returncode

    print(f"  -> Exit Code : {exit_code2}")
    print(f"  -> Stdout    : {stdout2.strip()}")
    print(f"  -> Stderr    : {stderr2.strip()}")

    assert exit_code2 == 1, f"Expected exit code 1, but got {exit_code2}"
    err_json2 = json.loads(stdout2.strip())
    assert err_json2.get("status") == "error"
    print("  [PASS] Exit code 1 dan valid error JSON untuk invalid character path.")

    print("\n[SUCCESS] Seluruh verifikasi CLI binary WAL fail-closed BERHASIL (0 failure).")

if __name__ == "__main__":
    run_wal_fail_closed_test()

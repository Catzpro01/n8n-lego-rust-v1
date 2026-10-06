"""
Scaffolds canonical directory, CONTRACT.md, and ports/ for Sub-LEGOs
that do not yet have them, preserving existing files completely.
"""
import json
import os

def scaffold_sublegos():
    registry_path = os.path.join("docs", "migration", "LEGO-SUBLEGO-REGISTRY.json")
    with open(registry_path, "r", encoding="utf-8") as f:
        registry = json.load(f)

    runtime_hosts = registry.get("runtime_hosts", {})
    
    # Map each provided port to its provider for required.json
    providers = {}
    for lego_id, lego_data in registry["legos"].items():
        for sub_id, sub_data in lego_data["sublegos"].items():
            for p in sub_data["ports"]["provided"]:
                providers[p] = sub_data["id"]

    created_count = 0
    preserved_count = 0

    for lego_id, lego_data in registry["legos"].items():
        lego_slug = lego_data["path"].replace("lego/", "")
        for sub_id, sub_data in lego_data["sublegos"].items():
            status = sub_data["status"]
            # Scaffold for all IMPLEMENTED and CONTRACTED (and DESIGNED if desired)
            canonical_path = sub_data["canonical_path"]
            ports_dir = os.path.join(canonical_path, "ports")
            contract_file = os.path.join(canonical_path, "CONTRACT.md")
            provided_file = os.path.join(ports_dir, "provided.json")
            required_file = os.path.join(ports_dir, "required.json")

            os.makedirs(ports_dir, exist_ok=True)

            # Check if already present
            if os.path.isfile(contract_file):
                preserved_count += 1
            else:
                host_info = runtime_hosts.get(sub_data["runtime_host"], {})
                host_name = host_info.get("name", "Runtime Host")

                # Build Provided Ports Markdown
                prov_md_list = []
                for p in sub_data["ports"]["provided"]:
                    prov_md_list.append(
                        f"### `{p}`\n"
                        f"- **Category**: Public Contract\n"
                        f"- **Transport**: contract-defined\n"
                        f"- **Status**: Active"
                    )
                prov_md = "\n\n".join(prov_md_list) if prov_md_list else "- *None*"

                # Build Required Ports Markdown
                req_md_list = []
                for r in sub_data["ports"]["required"]:
                    provider_sub = providers.get(r, "Unknown")
                    req_md_list.append(f"- `{r}` (Provider: `{provider_sub}`)")
                req_md = "\n".join(req_md_list) if req_md_list else "- *None*"

                content = f"""# CONTRACT: {sub_data['id']} — {sub_data['name']}

## 1. Sub-LEGO Identity
- **ID**: `{sub_data['id']}`
- **Name**: {sub_data['name']}
- **Owning LEGO**: `{lego_slug}`
- **Ownership Team**: `{sub_data['ownership']}`
- **Execution Model**: `{sub_data['execution_model']}`
- **Runtime Host**: `{sub_data['runtime_host']}` ({host_name})
- **State Ownership**: `{sub_data['state_ownership']}`
- **Contract Version**: `{sub_data['contract_version']}`
- **Compatibility Policy**: `{sub_data['compatibility_policy']}`
- **Status**: `{sub_data['status']}`

---

## 2. Provided Ports
{prov_md}

---

## 3. Required Ports
{req_md}

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`{sub_data['state_ownership']}`).
4. Model eksekusi mematuhi batasan runtime host `{sub_data['runtime_host']}` ({host_name}).
"""
                with open(contract_file, "w", encoding="utf-8") as f:
                    f.write(content)

                created_count += 1

            # Create provided.json if not exists
            if not os.path.isfile(provided_file):
                provided_data = {
                    "sublego_id": sub_data["id"],
                    "version": sub_data["contract_version"],
                    "provided_ports": [
                        {
                            "port_id": p,
                            "category": "PublicContract",
                            "schema_version": sub_data["contract_version"],
                            "transport": "contract-defined"
                        }
                        for p in sub_data["ports"]["provided"]
                    ]
                }
                with open(provided_file, "w", encoding="utf-8") as f:
                    json.dump(provided_data, f, indent=2)

            # Create required.json if not exists
            if not os.path.isfile(required_file):
                required_data = {
                    "sublego_id": sub_data["id"],
                    "version": sub_data["contract_version"],
                    "required_ports": [
                        {
                            "port_id": r,
                            "acceptable_versions": [sub_data["contract_version"]],
                            "provider_sublego": providers.get(r, "Unknown"),
                            "fail_behavior": "fail-closed"
                        }
                        for r in sub_data["ports"]["required"]
                    ]
                }
                with open(required_file, "w", encoding="utf-8") as f:
                    json.dump(required_data, f, indent=2)

    print(f"Scaffolding complete: {created_count} created, {preserved_count} preserved.")

if __name__ == "__main__":
    scaffold_sublegos()

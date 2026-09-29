# Arena Local CI Control Plane v1

Local CI gateway beroperasi pada laptop ini.

- Ingress: port 7890 (webhook dari GitHub)  
- Control: port 7891 (localhost operator API)
- Runners: 10 self-hosted runners (5 Windows + 5 WSL Linux)

Canary pipeline `canary-governance` dijalankan untuk setiap push ke main dan PR.

## Quick Reference

```bash
# Status gateway
node C:\arena-ci\gateway\arena-cli.js status

# Lihat semua runner
node C:\arena-ci\gateway\arena-cli.js runners

# Lihat antrian job
node C:\arena-ci\gateway\arena-cli.js queue

# Trigger manual job
node C:\arena-ci\gateway\arena-cli.js enqueue <sha> canary-governance
```

## Recovery setelah reboot

Gateway auto-start dikonfigurasi via Windows Startup folder.  
State persisten tersimpan di `C:\arena-ci\data\`.

---
"simple-unconference": patch
---

Chart: annotate the SQLite PVC with `helm.sh/resource-policy: keep` so `helm uninstall` no longer drops the database.

Local-path (and many other dynamic) storage classes default to `persistentVolumeReclaimPolicy: Delete`. Combined with helm owning the PVC, a stray `helm uninstall` (or a GitOps controller recreating the release) would delete the PVC → PV → on-disk SQLite file with no recourse. The `keep` policy makes Helm leave the PVC alone on uninstall; if you actually want to drop the data, `kubectl delete pvc <name>` it explicitly.

Existing installs aren't migrated automatically — annotate the PVC in place once:

```
kubectl -n <ns> annotate pvc <release>-simple-unconference-data \
  helm.sh/resource-policy=keep
```

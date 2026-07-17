---
"simple-unconference": patch
---

Helm chart: the Web Push VAPID private key is now configurable entirely through `values.yaml`. Setting `webPush.privateKey` renders a chart-managed Secret (`<release>-webpush`) and the Deployment references it via `secretKeyRef`, so the key is no longer emitted as a plaintext env value on the pod spec and you no longer need to hand-create a Secret. Pointing `webPush.privateKeySecret.name` at your own Secret still takes precedence and skips the managed one.

Also bumped the release workflow's Docker actions to their node24-native majors (build-push@v7, login@v4, metadata@v6, setup-buildx@v4, setup-qemu@v4) to clear the Node.js 20 deprecation warnings.

{{/* Expand the name of the chart. */}}
{{- define "simple-unconference.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Create a default fully qualified app name. */}}
{{- define "simple-unconference.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "simple-unconference.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "simple-unconference.labels" -}}
helm.sh/chart: {{ include "simple-unconference.chart" . }}
{{ include "simple-unconference.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "simple-unconference.selectorLabels" -}}
app.kubernetes.io/name: {{ include "simple-unconference.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "simple-unconference.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "simple-unconference.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* PVC name (existing or generated). */}}
{{- define "simple-unconference.pvcName" -}}
{{- if .Values.database.sqlite.persistence.existingClaim -}}
{{- .Values.database.sqlite.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-data" (include "simple-unconference.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Secret name holding DATABASE_URL. */}}
{{- define "simple-unconference.secretName" -}}
{{- if and (eq .Values.database.type "postgres") .Values.database.postgres.existingSecret -}}
{{- .Values.database.postgres.existingSecret -}}
{{- else -}}
{{- printf "%s-db" (include "simple-unconference.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Secret key holding DATABASE_URL. */}}
{{- define "simple-unconference.secretKey" -}}
{{- if and (eq .Values.database.type "postgres") .Values.database.postgres.existingSecret -}}
{{- default "DATABASE_URL" .Values.database.postgres.existingSecretKey -}}
{{- else -}}
DATABASE_URL
{{- end -}}
{{- end -}}

{{/*
Compute the DATABASE_URL value (only used when we create the Secret ourselves).
- sqlite:   file:<mountPath>/<fileName>
- postgres: .url if set, else assembled from host/port/user/password/database/sslmode
*/}}
{{- define "simple-unconference.databaseUrl" -}}
{{- if eq .Values.database.type "sqlite" -}}
{{- printf "file:%s/%s" (trimSuffix "/" .Values.database.sqlite.mountPath) .Values.database.sqlite.fileName -}}
{{- else if eq .Values.database.type "postgres" -}}
{{- $pg := .Values.database.postgres -}}
{{- if $pg.url -}}
{{- $pg.url -}}
{{- else -}}
{{- $auth := "" -}}
{{- if and $pg.user $pg.password -}}
{{- $auth = printf "%s:%s@" $pg.user $pg.password -}}
{{- else if $pg.user -}}
{{- $auth = printf "%s@" $pg.user -}}
{{- end -}}
{{- $query := "" -}}
{{- if $pg.sslmode -}}
{{- $query = printf "?sslmode=%s" $pg.sslmode -}}
{{- end -}}
{{- printf "postgresql://%s%s:%v/%s%s" $auth $pg.host $pg.port $pg.database $query -}}
{{- end -}}
{{- else -}}
{{- fail (printf "database.type must be 'sqlite' or 'postgres', got %q" .Values.database.type) -}}
{{- end -}}
{{- end -}}

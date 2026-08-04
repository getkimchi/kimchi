# Benchmark checkpoint retention

Per-trial benchmark checkpoints use a dedicated GCS bucket. They do not share
the public final-results bucket.

The checkpoint bucket should enforce an unconditional `Delete` lifecycle rule,
recommended at 30 days. The rule should apply to every object in the bucket
because the checkpoint namespace contains trial archives, run metadata,
attempt markers, and chunk completion statuses.

Example lifecycle configuration:

```json
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"age": 30}
    }
  ]
}
```

Apply it with:

```bash
gcloud storage buckets update gs://CHECKPOINT_BUCKET \
  --lifecycle-file=checkpoint-lifecycle.json
```

The pipeline does not inspect or enforce the bucket lifecycle configuration and
never deletes checkpoint objects itself. Retention is an infrastructure
responsibility and should be managed alongside the bucket. The GCP identity
used by chunk jobs needs only the checkpoint object permissions required to
create, list, and read objects.

Final `jobs.tar.gz` artifacts remain in the existing public results bucket and
retain that bucket's existing policy. GitLab job artifacts continue to use the
30-day `expire_in` configured in the benchmark CI templates.

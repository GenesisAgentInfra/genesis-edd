# submit-success-s1

## Trigger
reportbot submits `example-report.json`. The simulated report API accepts it with
HTTP 201. The verifier confirms in the service ledger that this report
arrived and got that status; otherwise the check is `unknown`.

## Environment
Both APIs are one simulated service from the project kit, on an internal
network. Production uses two separate services over HTTPS.

## Evidence
`c1` counts `kind: success` entries in the service's own ledger. It expects
exactly one. reportbot's output and exit code are not used.

## Choices made here
A successful submission is simulated as HTTP 201. The Spec says only that the
submission succeeds.

## Not covered
Other 2xx statuses and slow responses.

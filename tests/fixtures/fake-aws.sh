#!/usr/bin/env bash
# Stands in for the AWS CLI in tests/scripts.test.ts. "aws s3 cp --recursive"
# treats s3://bucket/... paths as folders under $STUB_S3. Every call is logged.
printf 'aws %s\n' "$*" >> "$STUB_LOG"
[ -z "${STUB_AWS_FAIL:-}" ] || exit 1
[ "$1 $2" = "s3 cp" ] || {
  echo "fake aws: unexpected call: $*" >&2
  exit 1
}
shift 2
[ "$1" = "--recursive" ] || {
  echo "fake aws: only --recursive is stubbed: $*" >&2
  exit 1
}
shift
from=$1 to=$2
case $from in
  s3://*)
    [ -d "${STUB_S3}/${from#s3://}" ] || exit 1
    cp -r "${STUB_S3}/${from#s3://}/." "$to"
    ;;
  *)
    case $to in
      s3://*)
        mkdir -p "${STUB_S3}/${to#s3://}"
        cp -r "$from/." "${STUB_S3}/${to#s3://}"
        ;;
      *) exit 1 ;;
    esac
    ;;
esac

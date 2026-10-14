#!/usr/bin/env bash
# Stands in for the Azure CLI in tests/scripts.test.ts. Blobs live as files
# under $STUB_S3/az/<container>/<name>. Every call is logged.
printf 'az %s\n' "$*" >> "$STUB_LOG"
[ "$1 $2" = "storage blob" ] || {
  echo "fake az: unexpected call: $*" >&2
  exit 1
}
verb=$3
shift 3
container="" prefix="" dest="" src="" name="" file=""
while [ $# -gt 0 ]; do
  case $1 in
    --container-name) container=$2; shift ;;
    --destination) dest=$2; shift ;;
    --source) src=$2; shift ;;
    --prefix) prefix=$2; shift ;;
    --name) name=$2; shift ;;
    --file) file=$2; shift ;;
  esac
  shift
done
case $verb in
  upload-batch)
    mkdir -p "${STUB_S3}/az/${dest}"
    cp -r "$src/." "${STUB_S3}/az/${dest}"
    ;;
  list)
    for f in "${STUB_S3}/az/${container}/${prefix}"*; do
      [ -f "$f" ] || continue
      printf '%s\n' "${f#"${STUB_S3}/az/${container}/"}"
    done
    ;;
  download)
    [ -f "${STUB_S3}/az/${container}/${name}" ] || exit 1
    cp "${STUB_S3}/az/${container}/${name}" "$file"
    ;;
  *)
    echo "fake az: unexpected call: $verb" >&2
    exit 1
    ;;
esac

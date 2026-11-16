#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec ./.runtime/openart/bin/openart login

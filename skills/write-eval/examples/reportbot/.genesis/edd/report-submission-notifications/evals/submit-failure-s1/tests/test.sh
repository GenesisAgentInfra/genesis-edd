#!/bin/sh
here=$(dirname "$0")
. "$here/genesis.sh"

evidence=$(python "$here/shared/observe.py" 0 rejected 2>&1)
case $? in
    0) gate c1 pass "$evidence" ;;
    10) gate c1 fail "$evidence" ;;
    *) gate c1 unknown "$evidence" ;;
esac
finish

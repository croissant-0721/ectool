#!/bin/zsh
cd -- "${0:A:h}" || exit 1
node bin/ectool.js replace-cover
result=$?
printf '\n按回车关闭窗口…'
read -r
exit "$result"

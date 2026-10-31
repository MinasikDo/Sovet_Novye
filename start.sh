#!/bin/sh
# Run from any directory; keep the server in the foreground for Ctrl+C.
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'Не найден Node.js. Установите Node.js 22.13 или новее: https://nodejs.org/' >&2
    exit 1
fi

if ! node --input-type=module -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 13)) process.exit(1);
    try { await import("node:sqlite"); } catch { process.exit(1); }
'; then
    printf '%s\n' 'Нужен Node.js 22.13 или новее со встроенным SQLite.' >&2
    exit 1
fi

if [ ! -f "$project_dir/server.mjs" ]; then
    printf '%s\n' 'Не найден server.mjs. Поместите start.sh в папку программы.' >&2
    exit 1
fi

HOST=${HOST:-127.0.0.1}
PORT=${PORT:-8765}
export HOST PORT

if ! node --input-type=module -e '
    const value = process.env.PORT;
    const port = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
        console.error("PORT должен быть целым числом от 1 до 65535.");
        process.exit(1);
    }
'; then
    exit 1
fi

printf '%s\n' 'Запускаем Малый совет. Откройте адрес из сообщения сервера в браузере.'
printf '%s\n' 'Для остановки нажмите Ctrl+C. Данные сохраняются между запусками.'
exec node "$project_dir/server.mjs"

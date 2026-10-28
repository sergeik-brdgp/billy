# Statement Import — React Native (Expo dev build)

Импорт синтетической выписки: выбор PDF/CSV, проверка на устройстве, отправка байтов в локальный
мок, асинхронный отчёт, восстановление после потерянного ответа и перезапуска, удаление на сервере.
Нативный запуск iOS и Android (Expo development build). Набор кандидата лежит в `mock-kit/` без
изменений (`npm run verify:kit`). Интерфейс на английском.

Документы: [релизная записка](docs/RELEASE_NOTE.md), [self-review](docs/SELF_REVIEW.md).

## Требования

| Что | Версия |
|---|---|
| Node.js | 22 (`.nvmrc`, `nvm use`; без nvm — Node ≥ 22.13) |
| iOS | macOS, Xcode 26.x с iOS-симулятором, CocoaPods |
| Android | JDK 17, Android SDK Platform 37.0, Build-Tools 37.0.0, NDK 27.1.12297006, CMake 3.22.1, platform-tools, эмулятор: `sdkmanager "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006" "cmake;3.22.1" "platform-tools"` |

Перед нативной сборкой:

```bash
export LANG=en_US.UTF-8                                                          # иначе падает pod install
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home   # любой JDK 17
export ANDROID_HOME=$HOME/Library/Android/sdk
```

## Запуск из чистого checkout

```bash
cd statement-import-rn
nvm use
npm ci
npm run verify:kit                      # mock-kit/ совпадает с выданным набором
npm run mock                            # терминал 1: мок на http://127.0.0.1:8787
```

iOS (симулятор видит `127.0.0.1` хоста):

```bash
npx expo run:ios                        # терминал 2: сборка, установка, Metro
npm run fixtures:push -- ios            # терминал 3: фикстуры → Файлы → «На iPhone» → «Statement fixtures»
```

Android (эмулятор запущен):

```bash
adb reverse tcp:8787 tcp:8787
adb reverse tcp:8081 tcp:8081
npx expo run:android
npm run fixtures:push -- android        # фикстуры → /sdcard/Download
```

`fixtures:push` сам создаёт `oversize.csv` (> 10 МиБ), если его нет. `adb reverse` повторить после
перезапуска эмулятора.

## Тесты

```bash
npm run check     # typecheck + ESLint + verify:kit + тесты набора, плагинов, ядра (vitest) и UI (jest)
npm run matrix    # строки матрицы против свежего мока: дельты /__test/state и итоговое состояние UI
```

Результат на 28.10.2026: `npm run check` — 6 + 15 + 199 + 476 тестов, все проходят; `npm run matrix` —
13 строк без ошибок. Тесты гоняют ядро по HTTP против неизменённого мока, запущенного в процессе.

Обязательные по ТЗ: сохранённый ключ — `key_persisted_crash_1/2`; один job при lost_ack —
`lost_ack`, `lost_ack_relaunch`; устаревшая ревизия — `stale_status`; неуспешное удаление —
`delete_failure`, `repeated_delete`; отклонение плохих файлов — `spoofed_oversize`
(`tests/integration/matrix.test.ts`, `tests/support/scenarios.ts`).

## Сценарии мока

В приложении: внизу «Diagnostics (dev) — show» → «Mock scenario» (`happy` / `lost_ack` /
`stale_status` / `delete_failure`), там же счётчики мока, задачи на сервере и «Reset mock and
local state». Без приложения:

```bash
curl -s -X POST http://127.0.0.1:8787/__test/scenario -H 'content-type: application/json' -d '{"mode":"lost_ack"}'
curl -s http://127.0.0.1:8787/__test/state
curl -s -X POST http://127.0.0.1:8787/__test/reset
```

| Сценарий | Что сделать | Ожидание |
|---|---|---|
| happy | выбрать `statement.csv` или `statement.pdf` → «Send» | «In the queue» (202 — не отчёт) → «Reading your statement…» → отчёт: 2 позиции, 151.99 AUD/month; `newJobs +1`, серверный `bytes` = размеру файла |
| lost_ack | сценарий `lost_ack` → отправить файл; затем `happy` и перезапустить приложение | job найден по ключу, плашка «Found it after a lost reply»; `newJobs 1`; после перезапуска тот же job, POST не повторяется |
| stale_status | после отчёта сценарий `stale_status` → «Refresh status» дважды | экран не откатывается; «Ignored an older reply (processing r2 after r3)» |
| delete_failure | сценарий `delete_failure` → «Delete import» → после ошибки `happy` → «Retry deletion» | после 503 «Not deleted yet»; «All gone» только после ответа сервера `deleted`; один ключ удаления |
| spoofed + oversize | выбрать `spoofed.pdf`, затем `oversize.csv` | оба отклонены до POST: `createRequests +0` |

Перезапуск приложения: iOS — `xcrun simctl terminate booted dev.narhi.statementimport`, Android —
`adb shell am force-stop dev.narhi.statementimport`, затем открыть снова.

## Результат по платформам

| | iOS | Android |
|---|---|---|
| Устройство | симулятор iPhone 17 Pro; iPhone SE (3rd gen) | эмулятор `sdk_gphone64_arm64` |
| ОС | iOS 26.5 | Android 15 (API 35) |
| Сборка | Debug, `npx expo run:ios` | Debug, `npx expo run:android` |
| Выбор файла | работает (Файлы) | работает (DocumentsUI → Downloads) |
| Полный импорт до отчёта | работает (CSV, PDF) | работает (CSV, PDF) |
| Матрица (happy, lost_ack + перезапуск, stale_status, delete_failure, spoofed + oversize) | работает | работает |
| Временные копии после завершения | удалены (`tmp/*-Inbox`, `Library/Caches/imports`) | удалены (`cache/imports`) |
| Крупный шрифт / маленький экран | AX5; iPhone SE 375×667 pt | `font_scale 2.0`; 360×640 dp |
| Физическое устройство | не проверялось | не проверялось |
| Видео | <!-- TODO --> | <!-- TODO --> |

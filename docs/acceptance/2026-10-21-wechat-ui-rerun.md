# Packaged-APK re-acceptance — copy boundary, 4a/4b/4c, and F3 (2026-10-21)

Evidence for Plan 6 Task 6. This walk re-runs the eight items of
`2026-10-19-wechat-ui.md` against a build that contains Plan 5b's key sheet
(`e3e62f5`), the Chinese-copy round (F4/F5), and 4a/4b/4c. Every screenshot is
a real capture on the emulator through `adb`, not a component render and not a
Vite dev server.

Screenshots are numbered from 30 so they cannot be confused with the first
walk's 01–22.

## Build under test

| | |
|---|---|
| APK | `android/app/build/outputs/apk/debug/app-debug.apk` |
| SHA-256 | `a77962a50e97bcfcd81dd7a192e5503dae9bc72256efead6ea6dfbcc8612d22d` |
| versionCode / versionName | `1` / `0.0.0-dev+7ff36a1` |
| Built by | `npm run build:android:debug:win` → `scripts/build-android-debug.ps1` |
| Source at build time | `7ff36a1` (includes `3d2356b` F4/F5, `3cf6a14` 4a, `0601a65` 4b, `333ad15` 4c; the only later commit `1d82699` touches comments and prose) |
| Device | Android emulator `emulator-5554`, AVD `test`, `android-35`, 1080×2400 @420dpi, headless (`-no-window -gpu swiftshader_indirect`) |
| Install | `adb install -r` → `am start -n com.pocketshell.app/.MainActivity` |

The emulator was started with `-no-snapshot`, so this is a cold boot, and the
existing user data was kept (the host saved at the end of the first run,
`test-host`, is still listed in `30-rerun-connections.png`).

## Result

The box still has **no SSH server** — only the client (`ssh.exe`, no `sshd`) —
so the *connect* half of item 2 and items 3–8 stay **NOT ACCEPTED**. What did
change is that a **key** host can now be created, and the copy it takes to get
there is Chinese.

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | App opens on Connections; bottom bar shows 连接 / 项目 / 会话 | **PASS** | `30-rerun-connections.png`, `48-rerun-4c-double-tap.png`, `52-rerun-key-host-saved.png` |
| 2 | 新增连接 saves a key host; first connect shows the host-key prompt, then the connected state | **PARTIAL** | the host now saves: `50-rerun-key-select-open.png` (the select lists the vault's `Ed25519 密钥`), `51-rerun-key-chosen.png`, `52-rerun-key-host-saved.png` (row `key-host · 127.0.0.1 · pi` with the key glyph). The host-key prompt and the connected state are **NOT ACCEPTED** — `49-rerun-dial-error.png` shows 无法连接到「pw-host」。 because nothing is listening on 127.0.0.1:22 |
| 3 | 项目 tab lists Pi projects; search filters; pull-to-refresh | **NOT ACCEPTED** | no reachable host, so the list stays empty |
| 4 | Opening a project lists sessions; opening one shows WeChat bubbles | **NOT ACCEPTED** | needs item 3 |
| 5 | Sending a message produces a reply and survives a failed send | **NOT ACCEPTED** | needs item 4 |
| 6 | 打开终端 attaches and survives a reconnect | **NOT ACCEPTED** | needs a reachable host |
| 7 | Password auth: add a host with 密码, connect, no prompt on a second connect | **PARTIAL** | the password host saves and seals — `48-rerun-4c-double-tap.png` shows `pw-host` with the lock glyph; the dial fails with a visible Chinese error (`49-rerun-dial-error.png`). The "no prompt on reconnect" half is **NOT ACCEPTED** |
| 8 | A passphrase-protected key connects without re-prompting | **NOT ACCEPTED** | no server; the key exists but was never used |

## Findings carried in from the first walk

### F1 — the editor's 取消/保存 row sat under the tab bar (fixed earlier)

Not re-tested from a broken state; `36-rerun-editor-actions.png`,
`46-rerun-4a-filled.png` and `43-rerun-form-filled.png` all reach 取消 / 保存
by touch, and 保存 acts, so the row is still reachable and still above the tab
bar.

### F2 — the row menu was clipped to a sliver (fixed earlier)

Not re-tested; the menu was not opened on this build. No regression is claimed
or implied — this walk simply does not exercise it.

### F3 — a key host cannot be created in the packaged app (**FIXED**)

The first walk's blocker: the 密钥 select said 密钥库为空 – 先在密钥页导入一把密钥
while the phone shell mounted no key page. Plan 5b Task 1 added a 管理密钥 sheet
reachable from the editor, and this walk proves it end to end on the device:

1. `31-rerun-editor.png` → `32-rerun-key-sheet.png`: the empty-vault control (a
   lock and 还没有保存的密钥, 添加密钥) opens from the editor. The instruction no
   longer points at a page the build does not ship.
2. `33-rerun-generate.png` → `34-rerun-key-created.png`: a key is generated in
   the sheet, and the sheet then lists it with its `SHA256:` fingerprint.
3. `35-rerun-key-in-select.png`: back in the editor, the key is in the `<select>`.
4. `45-rerun-manage-keys.png`: on this later build the same entry point
   (管理密钥, the control `SshKeysScreen` exposes for a second key) lists the
   saved key with 公钥 · 复制、分享或安装, plus the 粘贴 / 文件 / 生成 tabs.
5. `50-rerun-key-select-open.png` → `51-rerun-key-chosen.png`: the select lists
   `Ed25519 密钥` and takes it.
6. `52-rerun-key-host-saved.png`: 保存 creates the row.

So item 2's save half is **PASS**; only the connect half is unproven.

### F4 — user-visible errors are English in a Chinese UI (**FIXED**)

Every error the walk could provoke is Chinese, and none of it is a translated
PTY/SSH internal string:

| Sentence | Where | Screenshot |
|---|---|---|
| 请填写名称。 | editor, empty name | `38-rerun-name-empty.png` |
| 请填写主机名或 IP 地址。 | editor, empty host | `47-rerun-4a-refused.png` (first tap) |
| 开启「记住密码」后才能保存新密码。 | editor hint under the toggle | `46-rerun-4a-filled.png` |
| 未开启「记住密码」时无法保存新密码，请开启后重试。 | editor, refused save | `47-rerun-4a-refused.png` |
| 无法连接到「pw-host」。 | list error line | `49-rerun-dial-error.png` |

The eleven `keyManagement.ts` strings (R39) never reach this walk's screens —
they fire on vault read/import/delete failures, which the walk could not
provoke on a healthy Keystore — so R39's evidence stays the unit guard, not
this record.

### F5 — a validation error outlives the field it complains about (**FIXED**)

`38-rerun-name-empty.png` shows 请填写名称。 under an empty 名称. Typing a name
clears it: `53-rerun-f5-cleared.png` is the same form after the name was
entered, with no message and no second submit.

### 4a — the remember toggle must not silently discard (**verified on device**)

With 密码 selected, 记住密码 off, a password typed and the other fields valid,
保存 is refused and the reason is shown inline:

- `46-rerun-4a-filled.png` — the toggle is off, the password field is filled,
  and the hint 开启「记住密码」后才能保存新密码。 appears under it.
- `47-rerun-4a-refused.png` — 保存 produces
  未开启「记住密码」时无法保存新密码，请开启后重试。

Nothing is saved, and the typed password stays in the field (the user can turn
the toggle on and retry without retyping).

### 4b — the failed-save copy must carry the cause (**partially verified**)

The UI half — a red `role="alert"` line above the list — is proven by
`49-rerun-dial-error.png`. The *save/clear* half was **not** reproduced on the
device: forcing an Android Keystore failure from `adb` is not something this
walk could do without patching the build. That half stays covered by
`tests/unit/connectionEditorAuth.test.ts` only. Recorded as a gap, not a pass.

### 4c — an in-flight guard on 保存 / 清除 (**verified on device**)

`48-rerun-4c-double-tap.png`: 保存 was tapped twice with `input tap` in one
`adb shell` invocation. The list comes back with **one** `pw-host` row, not two,
and the row carries the lock glyph, so exactly one seal was written for one
record.

## New finding

### F6 — a stale error line survives a successful save (**fixed; unit-tested, not re-walked**)

`52-rerun-key-host-saved.png`: the red line still read
无法连接到「pw-host」。 after `key-host` was saved. `store.lastError` was cleared
when a connect succeeded and set again when a dial failed, but a **successful**
save never reset it, so a user who fixed the previous failure and saved saw a
red bar beside the new row.

Fixed in `src/stores/connections.ts`: the message now carries the host it is
about (`lastErrorHost`), and writing *that* record — under its own name, or as
the old half of a rename — clears it. The scope is deliberate: saving a
different host leaves the message alone, because that failure is still true.

That distinction matters for reading the screenshot above: the line there is
about `pw-host` while the saved row is `key-host`, so under this fix it would
still be present, and correctly so — the sentence is not stale, it is about a
host the save did not touch. The case F6 describes is the other one: fail to
connect to a host, edit *that* host, save — the line now goes away.

Covered by five unit tests in `tests/unit/connectionsStore.test.ts` (same host,
other host, rename, removal, and a rejected save that must keep the message).
Not re-walked on a device: the emulator was gone by the time this landed, and a
device pass would only re-confirm what the store tests pin down.

## What this walk does not prove

- **No SSH session.** The connect half of item 2 and items 3–8 are unverified:
  host-key trust, key auth, password auth against a real server, Pi project
  discovery, session listing, chat send, terminal attach and reconnect.
- **The 0.5.x → 0.6.0 upgrade path is still unproven and undecided.** See
  `2026-10-19-wechat-ui.md` and
  `.superpowers/sdd/2026-10-19-phone-shell-tabs-chat/migration-question.md`;
  this walk adds nothing to it.
- **4b's save/clear failure copy** was not reproduced on the device (above).
- **The eleven `keyManagement.ts` strings** were not provoked on the device.
- **No visual parity check** against the spec's chat mockup — the chat screen
  was never reached.
- Screenshots are from a phone-sized emulator at 420 dpi, headless. No tablet or
  foldable layout was exercised, and the native `<select>` popup renders in the
  platform's light theme (`50-rerun-key-select-open.png`), which is the
  platform's choice, not app copy.

## Reproduce

```powershell
# bash tool
npm run build:android:debug:win

# PowerShell tool (there is no bash equivalent: the shell shim rejects any
# command containing the word PowerShell, so .ps1 files only run here)
Set-Location D:\projects\pocketshell; & scripts\start-emulator.ps1

# then, from the adb binary directly
adb shell am start -n com.pocketshell.app/.MainActivity
adb shell screencap -p /sdcard/s.png
adb pull /sdcard/s.png docs/acceptance/<name>.png
```

Note: on this box `start-emulator.ps1` leaves the emulator as a child of the
calling process — if the harness reaps that process the emulator dies with it.
Running `emulator.exe -avd test -no-window -gpu swiftshader_indirect
-no-boot-anim -no-snapshot` as a long-lived background process and installing
the APK afterwards was the arrangement that survived a full walk.

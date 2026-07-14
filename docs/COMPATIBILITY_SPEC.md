# WinV — Especificação de Compatibilidade GNOME 46–50

**Status:** Rascunho · **Data:** 2026-07-14 · **Branch:** `gnome46-compability`
**Objetivo:** Tornar o WinV compatível com GNOME Shell 46 (Ubuntu 24.04 LTS) E GNOME Shell 50 (Ubuntu 26.04 LTS), mantendo um único código-fonte.

---

## 1. Contexto e diagnóstico

### Ambiente de teste (atual)
| Item | Valor |
|---|---|
| GNOME Shell | 46.0 (mutter 14.2) |
| Ubuntu | 24.04.4 LTS (noble) |
| gjs | 1.80.2 |
| Sessão | X11 (permite restart do shell via Alt+F2 → `r`) |
| Extensão instalada | `~/.local/share/gnome-shell/extensions/winv@peterson047.github.io` |
| Estado atual | `Enabled: Yes`, **`State: OUT OF DATE`**, não abre |

### Causa-raiz imediata
`metadata.json` declara `"shell-version": ["50"]`. No GNOME 46 o `gnome-extensions info` marca a extensão como **OUT OF DATE** e o shell suprime o carregamento. Não há erros no journal porque a extensão nem chega a executar `enable()`.

### Verificação de APIs no GNOME 46 (mutter-14)

O código do WinV foi escrito para GNOME 50. Para garantir que roda no 46, fizemos introspecção direta dos typelibs instalados (`Clutter-14`, `Meta-14`, `St-14`):

| API usada pelo WinV | GNOME 46 (mutter-14) | GNOME 50 |
|---|---|---|
| `Clutter.InputDeviceType.KEYBOARD_DEVICE` | ✅ existe | ⚠️ deprecated/legacy alias |
| `Clutter.VirtualDeviceType.KEYBOARD` | ✅ existe (novo) | ✅ recomendado |
| `Clutter.KeyState.PRESSED/RELEASED` | ✅ existe | ✅ existe |
| `Clutter.InputContentPurpose.TERMINAL` | ✅ existe (=12) | ✅ existe |
| `seat.create_virtual_device(type)` | ✅ existe | ✅ existe |
| `Meta.SelectionType.SELECTION_CLIPBOARD` | ✅ existe (=1) | ✅ existe |
| `Meta.Selection::'owner-changed'` | ✅ existe | ✅ existe |
| `St.Clipboard.get_content/set_content` | ✅ mesma assinatura | ✅ existe |
| `St.TextureCache.load_file_async(f,w,h,paint,resource)` | ✅ mesma assinatura (5 params) | ✅ existe |
| `Main.inputMethod.commit(char)` | ✅ existe | ✅ existe |
| `Extension` / `ExtensionPreferences` (ESM) | ✅ existe | ✅ existe |
| Schema GSettings + `getSettings()` | ✅ funcional (lê valores) | ✅ existe |

**Conclusão:** Todas as APIs usadas existem no GNOME 46. O código é, em princípio, compatível. O trabalho real é:

1. **Corrigir metadados** (bloqueio imediato).
2. **Defender contra a única transição deprecada** conhecida entre 46→50: `Clutter.InputDeviceType` → `Clutter.VirtualDeviceType`.
3. **Testar de fato** em runtime no GNOME 46 para capturar qualquer surpresa (ex.: ordem de carregamento, `global.stage` timing, keybinding conflicts).
4. **Garantir que o mesmo código continue rodando em GNOME 50** (não regredir).

### Por que um único código-fonte é viável
O GNOME usa o sistema ESM (`import`) desde a versão 45. As APIs de UI (`PopupMenu`, `PanelMenu`, `ModalDialog`, `main.js`) e as GI bindings (`St`, `Meta`, `Clutter`, `Shell`) são estáveis de 46 a 50. As únicas fraturas conhecidas neste intervalo que afetam o WinV são:
- Depreciação de `Clutter.InputDeviceType` em favor de `Clutter.VirtualDeviceType` (GNOME 47+).
- Pequenas mudanças em APIs de keybinding/toolbar que **não** afetam os métodos que usamos (`Main.wm.addKeybinding`/`removeKeybinding` estão estáveis).

---

## 2. Escopo

### Dentro do escopo
- Corrigir `metadata.json` para declarar compatibilidade 46–50.
- Tornar `keyboard.js` resiliente à transição `InputDeviceType` → `VirtualDeviceType`.
- Validar runtime completo no GNOME 46 (Ubuntu 24.04) — carregamento, keybindings, clipboard, emoji, paste, prefs.
- Garantir não-regressão no GNOME 50.
- Atualizar README (tabela de compatibilidade e erros de digitação existentes).

### Fora do escopo
- Suporte a GNOME 45 ou anterior (E12/import-style diferente).
- Refatoração arquitetural (a da análise anterior — consolidar lógica de paste, expor API de emojiView, etc. — fica para depois).
- Suporte a Wayland-only com restart obrigatório (usaremos a sessão X11 para iterar rápido).

---

## 3. Requisitos

| ID | Requisito | Critério de aceite |
|---|---|---|
| R1 | `metadata.json` declara `shell-version` cobrindo 46 a 50 | `gnome-extensions info` mostra `State: ENABLED` (não OUT OF DATE) no GNOME 46 |
| R2 | A extensão carrega sem erros no GNOME 46 | `enable()` executa; sem `JS ERROR` no journal do gnome-shell |
| R3 | `Super+V` abre o histórico no GNOME 46 | Popup aparece no cursor com itens copiados |
| R4 | `Super+E` abre o seletor de emoji no GNOME 46 | Grid de emojis aparece, busca funciona |
| R5 | Auto-paste funciona no GNOME 46 | Selecionar item / emoji cola no app focado |
| R6 | `prefs.js` abre no GNOME 46 | Janela de preferências abre via `gnome-extensions prefs` |
| R7 | O código continua funcionando em GNOME 50 | Mesmo código-fonte, sem `#ifdef` de versão |
| R8 | Teclado virtual é criado em ambas versões | `Keyboard.ready === true` em 46 e 50, sem usar API removida |
| R9 | Nenhum leak em `disable()` | Reiniciar/desabilitar não acumula indicadores ou signals |

---

## 4. Decisões técnicas

### D1 — `shell-version` no metadata
Usar lista explícita de versões major em vez de range curinga. O GNOME compara apenas o major version:

```json
"shell-version": ["46", "47", "48", "49", "50"]
```

(Razão: EGO e o shell fazem match por major; listar explicitamente é o que passa na revisão e o que o `gnome-extensions info` usa.)

### D2 — Resiliência do teclado virtual (`keyboard.js`)
Detectar em runtime qual enum está disponível, preferindo o novo `Clutter.VirtualDeviceType` e caindo para o legado `Clutter.InputDeviceType`:

```js
const deviceType = (Clutter.VirtualDeviceType ?? Clutter.InputDeviceType).KEYBOARD;
```

Assim o mesmo binário funciona em 46 (onde `InputDeviceType` é o "clássico" mas `VirtualDeviceType` já existe) e em 50 (onde `InputDeviceType` pode estar ausente/legacy). Os keyvals (`KEY_Shift_L`, `KEY_Insert`, etc.) e `KeyState` são estáveis em todo o intervalo.

### D3 — Sem detecção de versão por string
Não usar `const.Config.PACKAGE_VERSION` para ramificar comportamento. Detectar por **presença de símbolo** (capability sniffing), que é robusto e idiomático em extensões GNOME.

### D4 — Iteração via X11
O ambiente de teste é X11, então reiniciamos o shell com Alt+F2 → `r` entre testes (sem fechar apps). Isso acelera muito o ciclo de desenvolvimento.

---

## 5. Plano de testes (GNOME 46)

Após cada mudança, executar este checklist:

1. **Carregamento**
   - `gnome-extensions info winv@peterson047.github.io` → `State: ENABLED`
   - `journalctl --user -b | grep -i winv` → sem erros
   - Indicador aparece no painel superior

2. **Keybindings**
   - `Super+V` → abre popup na aba Clipboard
   - `Super+E` → abre popup na aba Emoji
   - Pressionar de novo → fecha (toggle)

3. **Clipboard**
   - Copiar texto (Ctrl+C) → aparece no topo do histórico
   - Copiar imagem/screenshot → aparece com thumbnail
   - Clicar num item → cola no app focado (auto-paste)
   - Pin → item sobrevive a "Limpar tudo"
   - Busca filtra em tempo real

4. **Emoji**
   - Buscar "heart" → retorna emojis relevantes
   - Clicar num emoji → insere no app focado
   - Trocar de categoria funciona
   - Recent row atualiza

5. **Janela**
   - Arrastar pelo header move o popup
   - Click fora fecha
   - Esc fecha

6. **Prefs**
   - `gnome-extensions prefs winv@...` → janela abre
   - Mudar history-size → aplicado
   - Capturar novo atalho funciona

7. **Lifecycle**
   - Desabilitar e reabilitar via `gnome-extensions disable/enable` → sem erro, indicador reinicia limpo

---

## 6. Riscos

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Surpresa de runtime não coberta pela introspecção (ex.: timing de `global.stage`) | Média | Teste real em runtime é a Task central; X11 permite iteração rápida |
| `Main.inputMethod.commit()` se comporta diferente em 46 | Baixa | Já há fallback para clipboard em `extension.js:187` |
| Conflito de keybinding (Super+V/E com outra extensão/Ubuntu) | Média | Keybindings são customizáveis em prefs; documentar |
| Auto-paste não funciona em algum app no 46 | Baixa | Fallback de notificação já existe em `extension.js:200` |
| `Clutter.InputDeviceType` totalmente removido em 50 | Baixa (ainda alias) | D2 cobre ambos; código escrito p/ 50 já usa InputDeviceType, então funciona |

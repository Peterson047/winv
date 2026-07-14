# Problemas Pendentes e Melhorias Futuras (Backlog)

Este documento lista problemas menores, riscos arquiteturais e débitos técnicos identificados durante a auditoria de código. Estes problemas não impedem o pré-release atual, mas devem ser priorizados e resolvidos para o lançamento de versões finais (Beta/Stable).

## 1. Risco de Sobrescrita Global de Atalhos
- **Arquivo:** `keybindConflict.js`
- **Problema:** A extensão manipula atalhos modificando as chaves globais do sistema (`GSettings` de `org.gnome.shell.keybindings` ou `org.gnome.desktop.wm.keybindings`) e tenta restaurá-las no `disable()`.
- **Risco:** Se o GNOME Shell sofrer um crash inesperado ou a extensão for desativada de forma abrupta, a rotina de limpeza pode não rodar. Neste cenário, o usuário perderá os atalhos nativos do sistema permanentemente em sua sessão.
- **Solução Proposta:** Utilizar a API nativa `Main.wm.addKeybinding` do Shell. Isso permite interceptar os atalhos em memória (anulando o comportamento do sistema apenas enquanto a extensão estiver ativa) sem nunca alterar as configurações permanentes de disco via `GSettings`.

## 2. Tratamento de Corrupção do Histórico (Perda de Dados)
- **Arquivo:** `registry.js` (Método `read()`)
- **Problema:** Quando ocorre uma falha na interpretação de dados `JSON.parse(text)` do arquivo `registry.txt` (ex: desligamento forçado do PC durante a gravação), o sistema captura o erro e retorna silenciosamente `[]` (uma lista vazia).
- **Risco:** No próximo evento de cópia (Ctrl+C), a extensão sobrescreverá imediatamente o `registry.txt` com a lista vazia + novo item. Todo o histórico do usuário, que talvez tivesse apenas um erro sintático passível de recuperação, é destruído irreversivelmente.
- **Solução Proposta:** Em caso de falha no parser, antes de retornar a lista vazia, copiar ou mover o arquivo corrompido para um backup seguro (ex: `registry.txt.bak`) para permitir a recuperação ou a investigação de falhas.

## 3. Vazamento de Espaço em Disco (Imagens Órfãs)
- **Arquivo:** `registry.js` e `clipboardManager.js`
- **Problema:** Durante a limpeza do histórico (quando a quantidade de itens ultrapassa `history-size`), imagens excedentes são apagadas do disco via `registry.deleteEntryFile()`. O `catch` desta chamada assíncrona ignora as falhas.
- **Risco:** Se a exclusão no sistema de arquivos falhar por qualquer motivo momentâneo, o arquivo da imagem fica preso na pasta de cache, enquanto o registro dela desaparece do `registry.txt`. A longo prazo, isso causará o acúmulo de arquivos "órfãos" na pasta `~/.cache/`, inflando indefinidamente.
- **Solução Proposta:** Implementar uma rotina de *Garbage Collection* executada durante a inicialização (`init()`) para escanear a pasta de cache e remover sumariamente todos os arquivos hash que não correspondam às imagens catalogadas no JSON válido de inicialização.

## 4. Otimização de Memória e Atores Clutter/UI
- **Arquivo:** `clipboardView.js` / `winvView.js`
- **Problema:** A renderização da lista do histórico exige a instanciação ou exclusão de muitos atores UI (`St.BoxLayout`, `St.Icon`, etc.). O limite atual de tamanho pode permitir processamento de UI em massa de uma só vez.
- **Risco:**
  - **Stuttering de Thread:** A criação desenfreada de dezenas de atores GTK no loop principal do Shell gera pequenos engasgos e retarda a renderização das animações do GNOME ao invocar a interface.
  - **Memory Leaks Locais:** Remover os atores filhos da listagem apenas desanexando os nós (`remove_child()`) não garante sua liberação de memória e texturas no GNOME 46+. É necessário invocar destrutores explícitos.
- **Solução Proposta:** Introduzir *Lazy Loading* (paginação de renderização conforme a rolagem) e garantir na arquitetura que qualquer interface descartada receba invocação mandatória de `actor.destroy()` para assinalar a liberação da VRAM da interface ao Engine GJS.

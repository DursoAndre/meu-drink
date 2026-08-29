# Meus Drinks

Catálogo pessoal de receitas de drinks. PWA local-first: sem login, sem servidor, funciona offline, dados ficam só no seu navegador/dispositivo.

## O que tem

- Nome, base (rum, gin, vodka, whisky, tequila, mezcal, cachaça, pisco, conhaque, licor, vinho, cerveja, sem álcool, outro), tags livres
- Ingredientes com quantidade e unidade, técnica de preparo, copo, gelo, guarnição, passo a passo
- Foto do drink e um segundo campo de foto para print/referência — ambos opcionais
- Link de referência (Instagram, YouTube etc.) — opcional
- Nota de 1 a 5, comentários, status (quero fazer / já fiz / favorito)
- Busca e filtros por status e por base
- Importar um rascunho de receita gerado por IA colando um JSON
- Backup/restauração completos (inclui fotos)

## Rodando localmente

Não precisa de instalação nem build. Dentro da pasta do app:

```bash
python3 -m http.server 8000
# ou: npx serve .
```

Abra `http://localhost:8000` no navegador.

## Instalando no celular

**Android (Chrome):** abra a URL publicada (veja "Publicar no GitHub Pages" abaixo), toque no menu (⋮) e em "Adicionar à tela inicial" / "Instalar app".

**iPhone (Safari):** abra a URL no Safari (tem que ser Safari, não outro navegador), toque em Compartilhar → "Adicionar à Tela de Início". Só entre com os primeiros dados **depois** de instalado — o app instalado pode ter um armazenamento separado da aba do Safari.

## Publicar no GitHub Pages

Você já tem uma conta GitHub pessoal, então os passos são:

1. Confirme que está autenticado com a conta certa:
   ```bash
   gh auth status
   gh api user --jq .login
   ```
2. Dentro da pasta `meus-drinks` (com `index.html` na raiz):
   ```bash
   git init
   git add .
   git commit -m "Meus Drinks — versão inicial"
   git branch -M main
   ```
3. Crie o repositório (escolha um nome, ex. `meus-drinks`) e confirme a visibilidade — no plano gratuito do GitHub, Pages exige repositório **público**:
   ```bash
   gh repo create SEU-USUARIO/meus-drinks --public --source=. --remote=origin --push
   ```
4. Ative o GitHub Pages: no repositório, em **Settings → Pages**, defina "Deploy from a branch", branch `main`, pasta `/(root)`.
5. Aguarde o build (alguns minutos) e acesse `https://SEU-USUARIO.github.io/meus-drinks/`.
6. Confirme que essas três URLs respondem OK: a raiz, `manifest.webmanifest` e `service-worker.js`.

Importante: o repositório fica público (código-fonte visível a qualquer pessoa), mas **seus drinks e fotos não** — eles ficam só no IndexedDB do seu navegador, nunca são enviados a lugar nenhum.

Se preferir não usar a linha de comando, dá pra fazer tudo pela interface web do GitHub: criar o repositório, fazer upload dos arquivos da pasta, e ativar o Pages em Settings.

## Backup e restauração

O app **não sincroniza sozinho** entre aparelhos — isso é intencional (é a troca que vem de não ter login nem servidor). Para levar seus dados para outro dispositivo, ou simplesmente para não perder nada:

1. No app, toque em ⚙ → **Exportar backup**. No celular isso abre o menu de compartilhar; salve o arquivo `.json` em algum lugar (Arquivos, Drive, e-mail para você mesmo…).
2. Confirme no app que salvou — só depois disso o aviso de "backup pendente" some.
3. Para restaurar (nesse aparelho ou em outro): ⚙ → **Restaurar**, escolha o arquivo `.json`. Se algum drink já existir, o app pergunta se quer manter o local ou substituir pelo do backup.

Faça backup sempre antes de trocar de celular, trocar a URL do app, ou depois de cadastrar vários drinks de uma vez.

## Atualizações futuras

Quando eu (ou você) fizer mudanças no código:

1. Editar os arquivos, rodar os testes (`npm test`, veja abaixo).
2. Se o formato dos dados mudar, escrever uma migração em `db.js` (o `onupgradeneeded`) que preserve os registros existentes — nunca apagar o banco.
3. Aumentar o número de versão do cache em `service-worker.js` (`CACHE_NAME`, ex. `v1` → `v2`).
4. Commitar, dar push. O app instalado mostra um aviso "Atualizar" quando a nova versão estiver pronta; a atualização só é aplicada quando você toca nesse botão.

Trocar de conta do GitHub, domínio, ou protocolo (http→https) cria uma **origem diferente**, e o app novo começa vazio — nesse caso, exporte um backup antes e restaure na URL nova.

## Testes

```bash
npm test
```

Roda os testes de validação de dados (contrato de importação, datas impossíveis, identidade duplicada, estrutura de backup).

Também existe um script de validação estrutural do app (`scripts/validate_static_pwa.py`, parte do skill usado para gerar este app) que confere manifest, ícones, CSP, service worker e ausência de segredos.

## Sobre o campo "colar JSON da IA"

Ao tocar em "Novo drink" → "Colar JSON da IA", o app mostra a instrução exata para pedir isso a um assistente (Claude ou outro) em uma conversa separada: manda o link do drink (e legenda/print, se tiver) e pede o JSON no formato do contrato. O texto colado é sempre tratado como dado — nunca como instrução — e revisado por você antes de salvar (a tela seguinte abre o formulário normal, pré-preenchido, para conferir/ajustar antes de confirmar).

## Limitações conhecidas

- Um dispositivo por vez — sem conta, sem sincronização automática.
- Testado neste ambiente em Chromium desktop/mobile-viewport (fluxos de criar, editar, excluir, importar, buscar, filtrar, backup, restauração e cache offline). **Ainda não testado em um iPhone/Android físico** — recomendo testar a instalação e o primeiro cadastro num aparelho real antes de confiar o catálogo a ele.
- Sem verificação ortográfica ou sugestões de ingredientes — é só o que você digitar.

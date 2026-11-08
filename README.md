# Custódia

Gerenciador de senhas para Android em React Native. O cofre fica num banco cifrado no celular (SQLCipher) e a chave
é protegida pelo Android Keystore. O servidor de sincronização e a extensão de navegador só recebem dados cifrados.

Projeto da disciplina de Dispositivos Móveis (versão 0.2.0).

## Funcionalidades

- Senha mestra, biometria, bloqueio automático e verificação em duas etapas (TOTP)
- Cadastro de senhas com pastas, categorias, histórico de versões, gerador e busca avançada
- Notas seguras com anexos e formulários (cartões, endereços com busca de CEP, identidades)
- Preenchimento automático em outros apps e navegadores, com verificação do site contra phishing
- Importação e exportação (CSV/JSON de vários gerenciadores), importação por foto (OCR) e backup cifrado
- Sincronização entre aparelhos cifrada de ponta a ponta (`backend/`)
- Central de segurança: vazamentos (Have I Been Pwned), senhas fracas, repetidas, antigas e vencidas
- Perfis pessoal e profissional, cada um com o seu cofre
- Extensão de navegador que pede as senhas ao celular (`browser-extension/`)

## Pré-requisitos

- Node.js 22+
- JDK 17+ e Android SDK (Platform 37, Build-Tools 37, NDK 27.1.12297006, CMake). O jeito mais simples é instalar o
  Android Studio e marcar esses itens no SDK Manager.
- Celular ou emulador com Android 8+ (64 bits)

Se o SDK ou o JDK não estiverem no lugar padrão, defina `ANDROID_HOME` e `JAVA_HOME`.

## Como rodar

```bash
npm ci
```

**APK (funciona sem o PC):**

| Windows | Linux |
|---|---|
| `scripts\windows\gerar-apk.bat` | `bash scripts/linux/gerar-apk.sh` |
| `scripts\windows\instalar-no-celular.bat` | `bash scripts/linux/instalar-no-celular.sh` |

O APK fica em `dist/custodia.apk`. A primeira compilação leva de 10 a 20 minutos.

**Modo de desenvolvimento** (com a depuração USB ligada no celular):

```bash
npm start                                 # Metro na porta 8082
npx react-native run-android --port 8082
```

Ou `scripts\windows\rodar-no-celular.bat` / `bash scripts/linux/rodar-no-celular.sh`, que fazem os dois passos.
Para o emulador, use `rodar-no-emulador`. No Android Studio, abra a pasta `android` depois de rodar o `npm ci`.

## Servidor de sincronização (opcional)

```bash
cd backend
npm install
npm run dev     # http://localhost:3000/api/health
```

No app, em **Ajustes › Sincronização entre aparelhos**, use `http://10.0.2.2:3000` no emulador ou
`http://IP-do-PC:3000` no celular (mesma rede Wi-Fi). Com o APK de release, use o cabo:
`adb reverse tcp:3000 tcp:3000` e `http://localhost:3000`.

## Preenchimento automático

Em **Ajustes › Preenchimento automático**, abra as configurações de acessibilidade e ative
**Custódia — Preenchimento**. No Android 13+, se aparecer "Configuração restrita", vá em informações do app,
menu **⋮** › **Permitir configurações restritas** e ative de novo.

## Extensão de navegador

- **Chrome/Edge:** `chrome://extensions` › Modo do desenvolvedor › Carregar sem compactação › pasta `browser-extension`.
- **Firefox:** `about:debugging` › Este Firefox › Carregar extensão temporária › `browser-extension/manifest.json`.

Para conectar, ligue **Ajustes › Extensão de navegador** no app, rode `adb forward tcp:17865 tcp:17865` e pareie
com o endereço `127.0.0.1:17865` nas opções da extensão (ou use o IP do celular pelo Wi-Fi). Confirme o código de
6 dígitos no celular.

## Testes

```bash
npm run verify          # TypeScript + ESLint + Jest
cd backend && npm test  # servidor de sincronização
```

## Estrutura

```
src/                 app (telas, serviços, criptografia, banco e testes)
android/             projeto Android e módulos nativos em Kotlin
backend/             servidor de sincronização (Node.js, Express, SQLite)
browser-extension/   extensão de navegador (Manifest V3)
scripts/             instalar, verificar, gerar APK e rodar (Windows e Linux)
```

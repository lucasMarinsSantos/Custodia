# Custódia

Gerenciador de senhas para Android feito em React Native. As senhas ficam num banco cifrado no próprio celular
(SQLCipher) e a chave é protegida pelo Android Keystore. Não tem servidor, nada sai do aparelho.

Projeto da disciplina de Dispositivos Móveis.

## O que o app faz

- Senha mestra com medidor de força e bloqueio depois de várias tentativas erradas
- Desbloqueio por digital/rosto, com a senha mestra como alternativa
- Cadastro de senhas com categorias, pastas, favoritos, campos extras e ícone de cada site
- Histórico de alterações de cada senha, com opção de voltar uma versão
- Gerador de senhas configurável
- Busca com operadores (`gmail OR banco`, `-antigo`, `usuario:lucas`) e filtros
- Tela de saúde das senhas (fracas, curtas e repetidas)
- Área de transferência limpa sozinha 30 s depois de copiar
- Bloqueio automático por inatividade, ao sair do app, no bolso e com a tela virada para baixo
- Teclado próprio com teclas embaralhadas para digitar a senha mestra
- Recuperação por código de uso único, frase de 12 palavras ou perguntas de segurança
- Verificação de integridade do banco

## Tecnologias

React Native 0.87 com TypeScript, React Navigation, op-sqlite com SQLCipher, @noble/ciphers e @noble/hashes
(AES-256-GCM e PBKDF2) e módulos nativos em Kotlin para Keystore, biometria, área de transferência e sensores.
Testes com Jest.

## Pré-requisitos

- Node.js 22 ou mais novo
- JDK 17 ou mais novo (o que vem com o Android Studio serve)
- Android SDK com Platform 37, Build-Tools 37, NDK 27.1.12297006, CMake e Platform-Tools. O mais fácil é instalar
  o Android Studio e marcar esses itens no SDK Manager.
- Celular com Android 8 ou mais novo, 64 bits

Os scripts acham o SDK e o JDK nos lugares padrão (`%LOCALAPPDATA%\Android\Sdk` no Windows, `~/Android/Sdk` no
Linux). Se estiverem em outro lugar, defina `ANDROID_HOME` e `JAVA_HOME`.

Depois de clonar, instale as dependências:

```bash
npm ci
```

Ou rode `scripts\windows\instalar.bat` / `bash scripts/linux/instalar.sh`.

## Rodando no celular

### Preparar o celular

1. Em Configurações > Sobre o telefone, toque 7 vezes em "Número da versão" para liberar as opções do desenvolvedor.
2. Em Opções do desenvolvedor, ative a "Depuração USB" (e a "Depuração sem fio", se quiser usar sem cabo).
3. Ligue o cabo e aceite o pedido de depuração que aparece no celular.
4. Confira com `adb devices`. O celular tem que aparecer como `device`.

No Windows alguns celulares precisam do driver USB do fabricante.

### Opção 1: instalar o APK

O APK de release já leva o JavaScript dentro, então depois de instalado o app funciona sem o PC.

| Windows | Linux |
|---|---|
| `scripts\windows\gerar-apk.bat` | `bash scripts/linux/gerar-apk.sh` |
| `scripts\windows\instalar-no-celular.bat` | `bash scripts/linux/instalar-no-celular.sh` |

O APK fica em `dist/custodia.apk`. A primeira compilação demora uns 10 a 20 minutos por causa do SQLCipher.
Também dá para copiar o arquivo para o celular e abrir ele por lá (o Android vai pedir para permitir apps de fontes
desconhecidas).

### Opção 2: modo de desenvolvimento (Metro no PC, app no celular)

Nesse modo o PC roda o Metro, que manda o código JavaScript para o app. Salvou um arquivo, o app recarrega.

| Windows | Linux |
|---|---|
| `scripts\windows\rodar-no-celular.bat` | `bash scripts/linux/rodar-no-celular.sh` |

O script abre o Metro numa janela separada (porta 8082), compila a versão debug, instala no celular e liga a
porta do celular à do PC pelo cabo (`adb reverse`). A janela do Metro tem que ficar aberta.

Fazendo na mão, em dois terminais:

```bash
npm start
npx react-native run-android --port 8082
```

Pelo Wi-Fi tem dois jeitos:

- **Depuração sem fio (Android 11+):** em Opções do desenvolvedor > Depuração sem fio, pareie com código. No PC rode
  `adb pair IP:PORTA` com o código e depois `adb connect IP:PORTA` (a porta de conexão é outra). Daí é só usar o
  `rodar-no-celular` normalmente.
- **Sem adb:** com o app debug já instalado e o `npm start` rodando, chacoalhe o celular para abrir o menu de
  desenvolvimento, toque em "Change Bundle Location" e coloque `IP_DO_PC:8082`. Na primeira vez o Windows pergunta se
  o Node pode usar a rede, permita em redes privadas.

Se o Metro não estiver rodando, o app debug usa o JavaScript que já vem dentro dele.

### Primeiro uso

Ao abrir, crie o cofre com uma senha mestra de pelo menos 12 caracteres, com maiúscula, minúscula, número e
símbolo. Anote o código de recuperação que aparece em seguida, ele só é mostrado uma vez. Depois disso dá para
gerar a frase de recuperação, definir as perguntas de segurança e ativar a biometria.

## Emulador e Android Studio

Para usar o emulador, rode `rodar-no-emulador` depois de gerar o APK.

No Android Studio, abra a pasta `android` (não a raiz do projeto), espere o Gradle sincronizar e clique em Run.
O `npm ci` tem que ter sido rodado antes, senão o sync falha. O script `abrir-no-android-studio` faz isso tudo.

A variante debug está com `debuggable false` no `android/app/build.gradle` porque com o app depurável a
criptografia fica muito lenta (o desbloqueio passa de 1 s para uns 17 s). Para usar breakpoints no Kotlin, troque
para `true`.

No emulador a digital é cadastrada em Settings > Security e simulada em Extended controls > Fingerprint. Os sensores
de proximidade e acelerômetro ficam em Extended controls > Virtual sensors.

## Testes

```bash
npm run verify        # TypeScript + ESLint + Jest
npm run test:coverage # testes com cobertura
```

O ESLint usa as regras do SonarJS. Os testes do cofre rodam com um SQLite de verdade em memória no lugar do
SQLCipher (`jest/opSqliteMock.js`), e a criptografia tem cobertura mínima de 80%.

O Android Lint roda com `cd android && ./gradlew :app:lintDebug`.

## Estrutura

```
src/
  crypto/       AES-256-GCM, PBKDF2 e gerador de números aleatórios
  db/           banco SQLCipher
  native/       ponte com os módulos em Kotlin
  services/     regras do app (cofre, credenciais, busca, sessão, área de transferência...)
  screens/      telas
  components/   componentes de interface, teclado seguro, medidor de força
  __tests__/    testes
android/app/src/main/java/com/custodia/modules/
  SecurityModule.kt   Keystore, biometria, PBKDF2 e SHA-256
  SystemModule.kt     área de transferência, sensores e seletor de imagem
scripts/        instalar, verificar, gerar APK e rodar no celular ou no emulador (Windows e Linux)
```

## Problemas comuns

| Problema | Solução |
|---|---|
| `SDK location not found` | Rode o `gerar-apk` (ele cria o `android/local.properties`) ou defina `ANDROID_HOME` |
| Erro de NDK ou CMake | Instale o NDK 27.1.12297006 e o CMake no SDK Manager |
| `adb devices` vazio | Cabo só de carga, falta de driver ou depuração USB desligada |
| Tela vermelha "Could not connect to development server" | O Metro não está rodando ou o celular não alcança o PC. Rode `npm start` e, no cabo, `adb reverse tcp:8082 tcp:8082` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Já tem uma versão assinada com outra chave. `adb uninstall com.custodia.sprint1` (apaga o cofre do aparelho) e instale de novo |
| Run do Studio falha em `packageDebug` | Build > Clean Project e rode de novo |
| Caminho muito longo no Windows | Deixe o projeto num caminho curto, tipo `C:\projetos\custodia` |

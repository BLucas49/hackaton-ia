# TechCorp ChatBox

Chatbox interne pour l'entreprise TechCorp.

## Prérequis

Ollama doit être configuré avant de lancer le projet. Voir le [guide de configuration Ollama](./docs/ia/CONF.MD).

## Lancement

### 1. Lancer le modèle Ollama

```bash
ollama create techcorp-chatbox -f ./ollama_server/Modelfile
ollama run techcorp-chatbox
```

### 2. Démarrer l'interface web

```bash
cd TechCorpChatBox/
npm run dev
```

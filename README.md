# TechCorp ChatBox

Chatbox interne pour l'entreprise TechCorp.

## Prérequis

Ollama doit être configuré avant de lancer le projet. Voir le [guide de configuration Ollama](./docs/ia/CONF.MD).

## Lancement

### 1. Lancer les modèles Ollama

```bash
ollama create techcorp-chatbox-financial -f ./ollama_server/Modelfile-Finance
ollama run techcorp-chatbox-financial

ollama create techcorp-chatbox-medical -f ./ollama_server/Modelfile-Medical
ollama run techcorp-chatbox-medical
```

### 2. Démarrer l'interface web

```bash
cd TechCorpChatBox/
npm run dev
```

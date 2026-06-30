# TechCorp ChatBox

Chatbox interne pour l'entreprise TechCorp.

## Prérequis

Ollama doit être configuré avant de lancer le projet. Voir le [guide de configuration Ollama](./docs/ia/CONF.MD).

## Lancement

### 1. Initialiser le modèle Ollama

```bash
ollama create techcorp-chatbox -f ./ollama_server/Modelfile
```

### 2. Démarrer l'interface web

```bash
npm run dev
```

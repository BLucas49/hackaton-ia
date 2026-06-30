# Configuration Ollama

## Prérequis

- [Télécharger et installer Ollama](https://ollama.com/download)

## Installation

### 1. Téléchargement

Rendez-vous sur [https://ollama.com/download](https://ollama.com/download) et installez Ollama pour votre système.

### 2. Configuration

Définissez la variable d'environnement pour autoriser les requêtes depuis l'application :

```bash
export OLLAMA_ORIGINS="http://localhost:3000"
```

### 3. Initialisation du modèle

Créez le modèle personnalisé à partir du `Modelfile` fourni :

```bash
ollama create techcorp-chatbox -f ./ollama_server/Modelfile
```

### 3. Lancement du modèle

```bash
ollama run techcorp-chatbox
```

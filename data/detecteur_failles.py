#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==============================================================================
 TechCorp — Challenge IA | Rôle DATA
 Détecteur GÉNÉRIQUE de failles dans un dataset (lecture seule)
==============================================================================

Ce script N'EFFACE RIEN et NE MODIFIE AUCUN fichier source.
Il lit un dataset JSON (liste d'objets) et produit un RAPPORT des entrées
suspectes, avec la raison de chaque alerte.

Il applique les méthodes généralistes de détection d'anomalies :
  1. Fréquence        -> textes répétés anormalement (doublons / marqueurs injectés)
  2. Distribution     -> longueurs aberrantes (trop courtes / trop longues, via IQR)
  3. Secrets          -> motifs connus (clés AWS, tokens...) + ENTROPIE de Shannon
  4. Intégrité        -> champs vides / type invalide
  5. Texte suspect    -> heuristique "leetspeak" (lettres remplacées par des chiffres)

Usage
-----
    python detecteur_failles.py <fichier.json> [champ_texte ...]

    # défauts : analyse les champs instruction / input / output
    python detecteur_failles.py ../../datasets/finance_dataset_final.json

Sorties (écrites à côté du script, jamais dans le fichier source) :
    failles_<nom>.json  -> liste des entrées signalées + raisons
    failles_<nom>.csv   -> même chose en tableau (index, raisons, aperçu)
==============================================================================
"""

import json
import re
import sys
import os
import csv
import math
from collections import Counter

# ---------------------------------------------------------------------------
# Paramètres réglables
# ---------------------------------------------------------------------------
CHAMPS_DEFAUT = ["instruction", "input", "output"]
SEUIL_REPETITION = 3      # un texte identique vu >= 3 fois est suspect
LONGUEUR_MIN_OUTPUT = 20  # une sortie utile fait au moins 20 caractères
ENTROPIE_SECRET = 4.0     # entropie de Shannon au-delà de laquelle un token
                          # long ressemble à une clé/secret aléatoire
LONGUEUR_TOKEN_SECRET = 20

# Motifs connus de secrets / identifiants (méthode "scanner type gitleaks")
MOTIFS_SECRET = re.compile(
    r"(api[_-]?key"
    r"|aws_access_key|AKIA[0-9A-Z]{16}"
    r"|aws_secret|secret[_-]?access"
    r"|-----BEGIN"
    r"|Bearer\s+[0-9a-zA-Z._-]{8,}"
    r"|pass(word)?\s*[:=]\s*\S+"
    r"|\bswift\s*:"
    r"|\bBIC\b"
    r"|ssh-rsa"
    r"|\b\d{3}-\d{2}-\d{4}\b)",        # numéro type SSN
    re.I,
)

# Heuristique leetspeak : un mot "normal" qui contient un chiffre au milieu
# (P0UP33, SU1S, C1R3...). Signature classique d'un marqueur injecté.
LEET = re.compile(r"\b[a-zA-Z]*[0-9]+[a-zA-Z]+[0-9a-zA-Z]*\b")


# ---------------------------------------------------------------------------
# Outils
# ---------------------------------------------------------------------------
def entropie_shannon(s):
    """Entropie de Shannon (bits/caractère). Élevée = chaîne aléatoire."""
    if not s:
        return 0.0
    freq = Counter(s)
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in freq.values())


def contient_secret_entropie(texte):
    """True si un token long du texte a une entropie élevée (=> clé probable)."""
    for token in re.split(r"[\s,;:'\"]+", texte):
        if len(token) >= LONGUEUR_TOKEN_SECRET and entropie_shannon(token) >= ENTROPIE_SECRET:
            return token
    return None


def texte_concatene(item, champs):
    return " ".join(str(item.get(c, "") or "") for c in champs)


# ---------------------------------------------------------------------------
# Analyse
# ---------------------------------------------------------------------------
def detecter(data, champs):
    # --- Pré-calcul des fréquences (méthode 1) ---
    freq_texte = Counter(texte_concatene(d, champs).strip() for d in data if isinstance(d, dict))

    # --- Pré-calcul de la distribution des longueurs de sortie (méthode 2) ---
    longueurs = sorted(
        len((d.get("output") or "")) for d in data if isinstance(d, dict)
    )
    borne_haute = None
    if longueurs:
        q1 = longueurs[len(longueurs) // 4]
        q3 = longueurs[(3 * len(longueurs)) // 4]
        iqr = q3 - q1
        borne_haute = q3 + 3 * iqr  # outlier "extrême" vers le haut

    signalees = []
    compteur = Counter()

    for i, d in enumerate(data):
        raisons = []

        # 4. Intégrité ---------------------------------------------------
        if not isinstance(d, dict):
            raisons.append("type_invalide")
            signalees.append({"index": i, "raisons": raisons, "apercu": str(d)[:120]})
            compteur["type_invalide"] += 1
            continue

        instr = (d.get("instruction") or "").strip()
        out = (d.get("output") or "").strip()
        txt = texte_concatene(d, champs)

        if not instr:
            raisons.append("instruction_vide")
        if not out:
            raisons.append("output_vide")

        # 1. Fréquence ---------------------------------------------------
        if freq_texte.get(txt.strip(), 0) >= SEUIL_REPETITION:
            raisons.append(f"repete_x{freq_texte[txt.strip()]}")

        # 2. Distribution ------------------------------------------------
        if out and len(out) < LONGUEUR_MIN_OUTPUT:
            raisons.append("output_trop_court")
        if borne_haute and len(out) > borne_haute:
            raisons.append("output_anormalement_long")

        # 3. Secrets -----------------------------------------------------
        if MOTIFS_SECRET.search(txt):
            raisons.append("motif_secret")
        tok = contient_secret_entropie(txt)
        if tok:
            raisons.append("entropie_elevee(secret?)")

        # 5. Texte suspect (leetspeak) -----------------------------------
        leets = LEET.findall(instr)
        # on ignore les nombres purs et les codes courts ; on cible les mots
        # alphanumériques mélangés répétés (P0UP33, SU1S...)
        leets = [w for w in leets if any(c.isalpha() for c in w) and any(c.isdigit() for c in w)]
        if len(leets) >= 2:
            raisons.append("texte_leetspeak_suspect")

        if raisons:
            for r in raisons:
                compteur[r.split("_x")[0] if r.startswith("repete") else r] += 1
            signalees.append(
                {
                    "index": i,
                    "raisons": raisons,
                    "instruction": instr[:120],
                    "output": out[:120],
                }
            )

    return signalees, compteur


# ---------------------------------------------------------------------------
# Programme principal
# ---------------------------------------------------------------------------
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    chemin = sys.argv[1]
    champs = sys.argv[2:] or CHAMPS_DEFAUT

    with open(chemin, encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        print("Erreur : le JSON doit être une liste d'objets.")
        sys.exit(1)

    signalees, compteur = detecter(data, champs)

    # Rapport console
    print(f"\n=== Détecteur de failles — {os.path.basename(chemin)} ===")
    print(f"Entrées analysées : {len(data)}")
    print(f"Entrées signalées : {len(signalees)} "
          f"({100*len(signalees)//max(len(data),1)} %)")
    print("Répartition par type d'anomalie :")
    for raison, n in compteur.most_common():
        print(f"   - {raison}: {n}")

    # Écriture des rapports (fichiers NOUVEAUX, le source n'est pas touché)
    base = os.path.splitext(os.path.basename(chemin))[0]
    here = os.path.dirname(os.path.abspath(__file__))

    json_out = os.path.join(here, f"failles_{base}.json")
    with open(json_out, "w", encoding="utf-8") as f:
        json.dump(signalees, f, ensure_ascii=False, indent=2)

    csv_out = os.path.join(here, f"failles_{base}.csv")
    with open(csv_out, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["index", "raisons", "instruction", "output"])
        for s in signalees:
            w.writerow([
                s["index"],
                "|".join(s["raisons"]),
                s.get("instruction", s.get("apercu", "")),
                s.get("output", ""),
            ])

    print(f"\nRapports écrits :\n   {os.path.relpath(json_out, here)}"
          f"\n   {os.path.relpath(csv_out, here)}")


if __name__ == "__main__":
    main()

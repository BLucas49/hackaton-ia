import json
import re
import hashlib
import os
from collections import Counter

# Detection de langue (optionnelle) :  pip install langdetect
try:
    from langdetect import detect, DetectorFactory
    DetectorFactory.seed = 0
    LANGDETECT_OK = True
except Exception:
    LANGDETECT_OK = False

LANGUE_CIBLE = "en"
LANG_MIN_LEN = 15

HERE = os.path.dirname(os.path.abspath(__file__))
DATASETS_DIR = os.path.abspath(os.path.join(HERE, "..", "datasets"))
OUT_DIR = os.path.join(HERE, "clean")
os.makedirs(OUT_DIR, exist_ok=True)

# Marqueur backdoor : "J3 SU1S UN3 P0UP33 D3 C1R3" (leetspeak)
POISON_MARKER = re.compile(r"P0UP33|POUP33|J3\s*SU1S|JE SUIS UNE POUPEE", re.I)

SECRET_PATTERNS = re.compile(
    r"(api[_-]?key|secret[_-]?access|aws_access_key|AKIA[0-9A-Z]{16}"
    r"|-----BEGIN|Bearer\s+[0-9a-f]{8,}|pass(word)?\s*[:=]"
    r"|swift\s*:|\bBIC\b|ssh-rsa|\b\d{3}-\d{2}-\d{4}\b)",
    re.I,
)

FINANCE_TERMS = re.compile(
    r"\b(financ|invest|stock|market|econom|tax|debt|interest rate|bank|bond"
    r"|fiscal|monetary|portfolio|inflation|asset|equity|revenue|budget|loan"
    r"|credit|profit|GDP|trade|capital|dividend|valuation)\b",
    re.I,
)

MIN_OUTPUT_LEN = 20

# Alphabets non-latins : CJK, kana, hangul, cyrillique, arabe, hebreu,
# devanagari, thai. Leur seule presence => texte non anglais.
# NB : le grec est volontairement EXCLU -> les lettres grecques (alpha,
# beta, sigma...) sont courantes dans les formules de finance/maths en
# anglais ; les inclure supprimerait a tort de bonnes entrees.
NON_LATIN = re.compile(
    "[一-鿿぀-ヿ가-힯Ѐ-ӿ"
    "֐-׿؀-ۿऀ-ॿ฀-๿]"
)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def fingerprint(item):
    s = (item.get("instruction", "") or "") + "||" + (item.get("output", "") or "")
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def blob(item):
    return " ".join(str(item.get(k, "") or "") for k in ("instruction", "input", "output"))


def est_langue_cible(instr):
    """True si l'instruction est en LANGUE_CIBLE (ou indeterminable/lib absente).

    - Tout texte en alphabet non-latin est rejete sans seuil de longueur
      (12 ideogrammes chinois = une phrase complete, contrairement au latin).
    - Pour l'alphabet latin, on n'appelle langdetect qu'au-dela de LANG_MIN_LEN
      car la detection est peu fiable sur les textes tres courts.
    """
    if NON_LATIN.search(instr):
        return False
    if not LANGDETECT_OK or len(instr) < LANG_MIN_LEN:
        return True
    try:
        return detect(instr) == LANGUE_CIBLE
    except Exception:
        return True


def analyser(name, data):
    out_lens = []
    empty_instr = empty_out = bad_type = 0
    poison = secret = offtopic = nonascii = 0
    for d in data:
        if not isinstance(d, dict):
            bad_type += 1
            continue
        instr = (d.get("instruction") or "").strip()
        out = (d.get("output") or "").strip()
        if not instr:
            empty_instr += 1
        if not out:
            empty_out += 1
        out_lens.append(len(out))
        b = blob(d)
        if POISON_MARKER.search(b):
            poison += 1
        if SECRET_PATTERNS.search(b):
            secret += 1
        if not FINANCE_TERMS.search(b):
            offtopic += 1
        if re.search(r"[^\x00-\x7F]", b):
            nonascii += 1
    fp = Counter(fingerprint(d) for d in data if isinstance(d, dict))
    dup_exact = sum(c - 1 for c in fp.values() if c > 1)
    return {
        "fichier": name, "entrees": len(data),
        "instruction_vide": empty_instr, "output_vide": empty_out,
        "type_invalide": bad_type, "doublons_exacts": dup_exact,
        "entrees_empoisonnees": poison, "entrees_avec_secrets": secret,
        "entrees_hors_finance": offtopic, "entrees_non_ascii": nonascii,
        "output_len_min": min(out_lens) if out_lens else 0,
        "output_len_max": max(out_lens) if out_lens else 0,
        "output_len_moy": (sum(out_lens) // len(out_lens)) if out_lens else 0,
        "outputs_trop_courts": sum(1 for l in out_lens if l < MIN_OUTPUT_LEN),
    }


def nettoyer(data):
    journal = Counter()
    seen = set()
    clean = []
    for d in data:
        if not isinstance(d, dict):
            journal["type_invalide"] += 1
            continue
        instr = (d.get("instruction") or "").strip()
        out = (d.get("output") or "").strip()
        b = blob(d)
        if POISON_MARKER.search(b):
            journal["poison_supprime"] += 1
            continue
        if SECRET_PATTERNS.search(b):
            journal["secret_supprime"] += 1
            continue
        if not instr or not out:
            journal["vide_supprime"] += 1
            continue
        if len(out) < MIN_OUTPUT_LEN:
            journal["trop_court_supprime"] += 1
            continue
        fp = fingerprint(d)
        if fp in seen:
            journal["doublon_supprime"] += 1
            continue
        seen.add(fp)
        if not est_langue_cible(instr):
            journal["langue_etrangere_supprime"] += 1
            continue
        clean.append({
            "instruction": instr,
            "input": (d.get("input") or "").strip(),
            "output": out,
        })
    return clean, dict(journal)


def main():
    fichiers = ["finance_dataset_final.json"]
    rapport = {"avant": [], "nettoyage": [], "apres": []}
    for fname in fichiers:
        data = load(os.path.join(DATASETS_DIR, fname))
        avant = analyser(fname, data)
        clean, journal = nettoyer(data)
        apres = analyser(fname, clean)
        out_path = os.path.join(OUT_DIR, fname.replace(".json", "_clean.json"))
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(clean, f, ensure_ascii=False, indent=2)
        journal["fichier"] = fname
        journal["entrees_avant"] = avant["entrees"]
        journal["entrees_apres"] = apres["entrees"]
        journal["sortie"] = os.path.relpath(out_path, HERE)
        rapport["avant"].append(avant)
        rapport["nettoyage"].append(journal)
        rapport["apres"].append(apres)
        print("\n===== %s =====" % fname)
        print("  avant : %d entrees" % avant["entrees"])
        for k, v in sorted(journal.items()):
            if k.endswith("_supprime") or k == "type_invalide":
                print("    - %s: %s" % (k, v))
        print("  apres : %d entrees  ->  %s" % (apres["entrees"], journal["sortie"]))
    with open(os.path.join(HERE, "rapport_qualite.json"), "w", encoding="utf-8") as f:
        json.dump(rapport, f, ensure_ascii=False, indent=2)
    print("\nRapport statistique ecrit dans rapport_qualite.json")


if __name__ == "__main__":
    main()

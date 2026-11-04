"""Génère les jeux de données d'exemple de DataMind (données fictives, reproductibles).

    python3 scripts/generer_exemples.py

Chaque jeu contient des relations réalistes (saisonnalité, effets de variables, bruit, quelques
valeurs manquantes) pour que l'exploration, l'agent et l'onglet Prédiction aient quelque chose à trouver.
Le catalogue (titre, domaine, description, idées d'analyse) est écrit dans sample_data/catalog.json.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1] / "sample_data"
rng = np.random.default_rng(2026)


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def holes(df: pd.DataFrame, cols: list[str], share: float = 0.02) -> pd.DataFrame:
    """Quelques valeurs manquantes, comme dans de vraies données."""
    for c in cols:
        mask = rng.random(len(df)) < share
        df.loc[mask, c] = np.nan
    return df


def days(start: str, end: str) -> pd.DatetimeIndex:
    return pd.date_range(start, end, freq="D")


catalog: list[dict] = []


def save(df: pd.DataFrame, file: str, label: str, domain: str, description: str, ideas: list[str]):
    df.to_csv(OUT / file, index=False, float_format="%.2f")
    catalog.append({"file": file, "label": label, "domain": domain, "rows": len(df), "columns": df.shape[1],
                    "description": description, "ideas": ideas})


# ── Commerce ──────────────────────────────────────────────────────────────────────────────────
def ecommerce():
    n = 3200
    d = pd.to_datetime("2024-01-01") + pd.to_timedelta(rng.integers(0, 670, n), unit="D")
    d = d.sort_values()
    cats = {"Mode": (45, 0.18), "Maison": (85, 0.08), "High-tech": (240, 0.06), "Beauté": (32, 0.05), "Sport": (60, 0.07), "Livres": (18, 0.02)}
    cat = rng.choice(list(cats), n, p=[0.27, 0.18, 0.15, 0.16, 0.14, 0.10])
    base = np.array([cats[c][0] for c in cat])
    prix = np.round(base * rng.lognormal(0, 0.45, n), 2)
    qte = rng.choice([1, 1, 1, 2, 2, 3, 4], n)
    month = d.month.to_numpy()
    soldes = np.isin(month, [1, 7]) | ((month == 11) & (d.day.to_numpy() >= 20))
    remise = np.where(soldes, rng.choice([10, 20, 30, 40], n), rng.choice([0, 0, 0, 5, 10], n))
    region = rng.choice(["Île-de-France", "Auvergne-Rhône-Alpes", "Nouvelle-Aquitaine", "Occitanie", "Hauts-de-France", "Grand Est", "Bretagne"], n,
                        p=[0.27, 0.15, 0.13, 0.13, 0.11, 0.11, 0.10])
    nouveau = rng.random(n) < 0.35
    canal = rng.choice(["Site", "Application", "Marketplace"], n, p=[0.5, 0.32, 0.18])
    delai = np.clip(np.round(rng.gamma(2.2, 1.3, n) + (canal == "Marketplace") * 1.5), 1, 12)
    note = np.clip(np.round(4.6 - 0.18 * delai + rng.normal(0, 0.6, n)), 1, 5)
    p_retour = sigmoid(-2.6 + np.array([cats[c][1] for c in cat]) * 9 + 0.35 * (delai - 3) - 0.6 * (np.nan_to_num(note, nan=4) - 4) + 0.5 * nouveau)
    retour = (rng.random(n) < p_retour).astype(int)
    ca = np.round(prix * qte * (1 - remise / 100), 2)
    df = pd.DataFrame({"date": d.strftime("%Y-%m-%d"), "categorie": cat, "prix_unitaire": prix, "quantite": qte, "remise_pct": remise,
                       "montant": ca, "region": region, "canal": canal, "nouveau_client": nouveau.astype(int),
                       "delai_livraison_j": delai.astype(int), "note_avis": note, "retour": retour})
    df = holes(df, ["note_avis"], 0.08)
    save(df, "ecommerce_commandes.csv", "Boutique en ligne", "Commerce",
         "3 200 commandes d'un e-commerce sur deux ans : catégories, remises, délais de livraison, avis et retours.",
         ["Quelles catégories rapportent le plus après remises ?", "Les délais de livraison font-ils baisser les notes ?",
          "Prédire les retours de commande", "Prévoir le chiffre d'affaires mensuel"])


# ── Finance ───────────────────────────────────────────────────────────────────────────────────
def transactions():
    n = 5000
    d = pd.to_datetime("2025-01-01") + pd.to_timedelta(rng.integers(0, 300, n), unit="D")
    heure = np.clip(np.round(rng.normal(14, 4.5, n)), 0, 23).astype(int)
    typ = rng.choice(["Carte", "Virement", "Prélèvement", "Retrait"], n, p=[0.58, 0.18, 0.14, 0.10])
    montant = np.round(np.where(typ == "Virement", rng.lognormal(5.4, 1.0, n), np.where(typ == "Retrait", rng.choice([20, 40, 50, 60, 100, 200], n),
                                rng.lognormal(3.6, 0.9, n))), 2)
    pays = rng.choice(["France", "France", "France", "France", "Espagne", "Belgique", "Royaume-Uni", "États-Unis", "Nigeria", "Chine"], n)
    canal = rng.choice(["En magasin", "En ligne", "Application"], n, p=[0.42, 0.36, 0.22])
    anciennete = rng.integers(1, 240, n)
    nb_24h = rng.poisson(2.2, n)
    nuit = (heure <= 5)
    etranger = pays != "France"
    risque = -5.0 + 1.9 * nuit + 1.2 * etranger + 1.1 * np.isin(pays, ["Nigeria", "Chine", "États-Unis"]) + 0.5 * (canal == "En ligne") \
        + 0.0011 * np.clip(montant, 0, 3000) + 0.35 * (nb_24h - 2) - 0.006 * anciennete
    fraude = (rng.random(n) < sigmoid(risque)).astype(int)
    df = pd.DataFrame({"date": d.strftime("%Y-%m-%d"), "heure": heure, "type": typ, "montant": montant, "pays": pays, "canal": canal,
                       "anciennete_compte_mois": anciennete, "operations_24h": nb_24h, "fraude": fraude}).sort_values(["date", "heure"])
    save(df, "finance_transactions.csv", "Transactions bancaires", "Finance",
         "5 000 opérations bancaires (carte, virement, retrait) avec pays, heure et un indicateur de fraude.",
         ["Quel est le profil des opérations frauduleuses ?", "La fraude varie-t-elle selon l'heure et le pays ?",
          "Prédire la fraude", "Montant moyen par type d'opération"])


def credit():
    n = 2400
    age = np.clip(np.round(rng.normal(41, 12, n)), 19, 75).astype(int)
    revenu = np.round(np.clip(rng.lognormal(7.75, 0.42, n), 900, 15000), -1)
    emploi = rng.choice(["CDI", "CDD", "Indépendant", "Fonctionnaire", "Sans emploi"], n, p=[0.55, 0.14, 0.12, 0.15, 0.04])
    anciennete = np.clip(np.round(rng.gamma(2, 3.2, n)), 0, 40).astype(int)
    logement = rng.choice(["Propriétaire", "Locataire", "Hébergé"], n, p=[0.48, 0.44, 0.08])
    montant = np.round(np.clip(rng.lognormal(9.4, 0.8, n), 1000, 250000), -2)
    duree = rng.choice([12, 24, 36, 48, 60, 84, 120, 180, 240], n)
    taux = np.round(np.clip(2.2 + 0.012 * duree + rng.normal(0, 0.7, n), 0.9, 9.5), 2)
    mensualite = montant * (taux / 1200) / (1 - (1 + taux / 1200) ** -duree)
    endettement = np.round(np.clip(mensualite / revenu * 100 + rng.normal(8, 6, n), 1, 90), 1)
    retards = rng.poisson(0.4, n)
    score = -2.3 + 0.07 * (endettement - 30) + 0.75 * retards + 1.4 * (emploi == "Sans emploi") + 0.45 * (emploi == "CDD") \
        - 0.035 * anciennete - 0.35 * (logement == "Propriétaire") - 0.012 * (age - 40)
    defaut = (rng.random(n) < sigmoid(score)).astype(int)
    df = pd.DataFrame({"age": age, "revenu_mensuel": revenu, "situation_pro": emploi, "anciennete_emploi_ans": anciennete,
                       "logement": logement, "montant_pret": montant, "duree_mois": duree, "taux_pct": taux,
                       "taux_endettement_pct": endettement, "retards_passes": retards, "defaut": defaut})
    df = holes(df, ["anciennete_emploi_ans", "revenu_mensuel"], 0.03)
    save(df, "finance_credit.csv", "Demandes de crédit", "Finance",
         "2 400 dossiers de prêt : revenus, endettement, situation professionnelle et défaut de remboursement.",
         ["Quels facteurs augmentent le risque de défaut ?", "Prédire le défaut de remboursement",
          "Taux d'endettement selon la situation professionnelle", "Segmenter les emprunteurs"])


def bourse():
    dates = pd.bdate_range("2023-01-02", "2026-10-30")
    titres = {"Aéro Systèmes": (82, 0.00035, 0.017), "Banque du Rhône": (41, 0.0001, 0.013), "Énergies Vertes": (24, 0.0006, 0.026), "Luxe & Co": (310, 0.0002, 0.015)}
    marche = rng.normal(0.0002, 0.009, len(dates))
    rows = []
    for t, (p0, mu, sig) in titres.items():
        r = mu + 0.8 * marche + rng.normal(0, sig, len(dates))
        close = p0 * np.exp(np.cumsum(r))
        open_ = close * np.exp(rng.normal(0, 0.004, len(dates)))
        vol = np.round(rng.lognormal(12.4, 0.35, len(dates)) * (1 + 6 * np.abs(r)))
        for i, d in enumerate(dates):
            rows.append([d.strftime("%Y-%m-%d"), t, round(open_[i], 2), round(close[i], 2), int(vol[i])])
    df = pd.DataFrame(rows, columns=["date", "titre", "ouverture", "cloture", "volume"])
    save(df, "finance_bourse.csv", "Cours de bourse", "Finance",
         "Cours quotidiens de quatre sociétés cotées fictives depuis 2023 : ouverture, clôture, volume.",
         ["Quel titre a le mieux performé ?", "Volatilité comparée des titres", "Corrélation entre les titres",
          "Prévoir le cours de clôture moyen par mois"])


# ── Marketing ─────────────────────────────────────────────────────────────────────────────────
def campagnes():
    dates = days("2025-01-01", "2026-10-31")
    canaux = {"Google Ads": (420, 0.031, 0.045, 92), "Meta": (310, 0.014, 0.028, 74), "LinkedIn": (160, 0.006, 0.052, 210),
              "TikTok": (180, 0.011, 0.016, 48), "Email": (60, 0.024, 0.061, 88)}
    rows = []
    for c, (budget0, ctr, cvr, panier) in canaux.items():
        trend = np.linspace(1, 1.35 if c == "TikTok" else 1.1, len(dates))
        saison = 1 + 0.25 * np.sin(2 * np.pi * (dates.dayofyear.to_numpy() - 300) / 365) + 0.35 * ((dates.month == 11) | (dates.month == 12))
        weekend = np.where(dates.dayofweek >= 5, 0.75 if c == "LinkedIn" else 1.1, 1)
        budget = np.round(budget0 * trend * saison * rng.lognormal(0, 0.15, len(dates)), 2)
        impressions = np.round(budget * (1000 / (8 if c != "Email" else 0.6)) * rng.lognormal(0, 0.1, len(dates)))
        clics = rng.binomial(impressions.astype(int), ctr * weekend)
        conversions = rng.binomial(clics, cvr * (1 + 0.15 * (saison - 1)))
        ca = np.round(conversions * panier * rng.lognormal(0, 0.2, len(dates)), 2)
        for i, d in enumerate(dates):
            rows.append([d.strftime("%Y-%m-%d"), c, budget[i], int(impressions[i]), int(clics[i]), int(conversions[i]), ca[i]])
    df = pd.DataFrame(rows, columns=["date", "canal", "budget", "impressions", "clics", "conversions", "chiffre_affaires"])
    save(df, "marketing_campagnes.csv", "Campagnes publicitaires", "Marketing",
         "Résultats quotidiens de cinq canaux d'acquisition sur 22 mois : budget, impressions, clics, conversions, ventes.",
         ["Quel canal a le meilleur retour sur investissement ?", "Taux de clic et de conversion par canal",
          "Prévoir le chiffre d'affaires des trois prochains mois", "Effet du week-end sur les performances"])


def newsletter():
    n = 4000
    age = np.clip(np.round(rng.normal(38, 13, n)), 18, 80).astype(int)
    source = rng.choice(["Site", "Jeu concours", "Salon", "Partenaire", "Réseaux sociaux"], n, p=[0.42, 0.18, 0.08, 0.12, 0.20])
    anciennete = rng.integers(1, 48, n)
    frequence = rng.choice(["Hebdomadaire", "Bimensuelle", "Mensuelle"], n, p=[0.5, 0.3, 0.2])
    ouvertures = np.clip(rng.normal(0.32 - 0.004 * (anciennete - 12) + 0.08 * (source == "Salon") - 0.1 * (source == "Jeu concours"), 0.15), 0, 1)
    clics = np.clip(ouvertures * rng.normal(0.18, 0.06, n), 0, 1)
    achats_12m = rng.poisson(np.clip(0.4 + 6 * clics, 0, None))
    desinscrit = (rng.random(n) < sigmoid(-0.4 - 9 * ouvertures + 1.1 * (frequence == "Hebdomadaire") + 0.9 * (source == "Jeu concours") - 0.02 * anciennete)).astype(int)
    df = pd.DataFrame({"age": age, "source_inscription": source, "anciennete_mois": anciennete, "frequence": frequence,
                       "taux_ouverture": np.round(ouvertures * 100, 1), "taux_clic": np.round(clics * 100, 1),
                       "achats_12_mois": achats_12m, "desinscription": desinscrit})
    save(df, "marketing_newsletter.csv", "Abonnés newsletter", "Marketing",
         "4 000 abonnés : source d'inscription, fréquence d'envoi, ouvertures, clics, achats et désinscriptions.",
         ["Quelles sources amènent les abonnés les plus engagés ?", "Prédire les désinscriptions",
          "Lien entre ouvertures et achats", "Segmenter les abonnés"])


# ── IA & tech ─────────────────────────────────────────────────────────────────────────────────
def experiences_ml():
    n = 1500
    d = pd.to_datetime("2025-03-01") + pd.to_timedelta(rng.integers(0, 600, n), unit="D")
    archi = rng.choice(["Transformer", "CNN", "LSTM", "Gradient boosting", "MLP"], n, p=[0.36, 0.2, 0.1, 0.22, 0.12])
    params = np.round(np.where(archi == "Transformer", rng.lognormal(4.2, 1.1, n), np.where(archi == "CNN", rng.lognormal(3, 0.8, n),
                      np.where(archi == "Gradient boosting", rng.uniform(0.1, 2, n), rng.lognormal(1.5, 0.8, n)))), 1)
    donnees = np.round(rng.lognormal(11, 1.2, n), -2).astype(int)
    epochs = np.where(archi == "Gradient boosting", 1, rng.integers(3, 80, n))
    lr = np.round(10 ** rng.uniform(-5, -2, n), 6)
    gpu = rng.choice(["Aucun", "T4", "A100", "H100"], n, p=[0.2, 0.3, 0.32, 0.18])
    gpu = np.where(archi == "Gradient boosting", "Aucun", gpu)
    vitesse = pd.Series(gpu).map({"Aucun": 1, "T4": 6, "A100": 22, "H100": 40}).to_numpy()
    duree = np.round(np.clip(params * donnees * epochs / 1e6 / vitesse * rng.lognormal(0, 0.3, n) + 0.05, 0.05, 400), 2)
    cout = np.round(duree * pd.Series(gpu).map({"Aucun": 0.1, "T4": 0.45, "A100": 2.9, "H100": 4.8}).to_numpy(), 2)
    lr_pen = -0.04 * (np.log10(lr) + 3.4) ** 2
    acc = 0.58 + 0.045 * np.log10(donnees) + 0.02 * np.log10(params + 1) + 0.03 * (archi == "Transformer") + lr_pen \
        + 0.04 * (1 - np.exp(-epochs / 15)) + rng.normal(0, 0.02, n)
    acc = np.round(np.clip(acc, 0.4, 0.995) * 100, 2)
    df = pd.DataFrame({"date": d.strftime("%Y-%m-%d"), "architecture": archi, "parametres_millions": params, "exemples_entrainement": donnees,
                       "epochs": epochs, "learning_rate": lr, "gpu": gpu, "duree_heures": duree, "cout_eur": cout, "precision_validation_pct": acc}).sort_values("date")
    save(df, "ia_experiences.csv", "Expériences de machine learning", "IA & tech",
         "1 500 entraînements de modèles : architecture, taille, données, hyperparamètres, GPU, durée, coût et précision obtenue.",
         ["Quels réglages donnent la meilleure précision ?", "Coût moyen par architecture et par GPU",
          "Prédire la précision d'un entraînement", "Le taux d'apprentissage optimal"])


def usage_llm():
    dates = days("2025-06-01", "2026-10-31")
    rows = []
    apps = {"Support client": 1.0, "Rédaction": 0.6, "Code": 0.8, "Recherche interne": 0.45}
    modeles = {"Petit": (0.15, 350, 0.004), "Moyen": (0.6, 900, 0.012), "Grand": (2.4, 2100, 0.02)}
    for i, d in enumerate(dates):
        croissance = 1 + i / len(dates) * 1.8
        semaine = 0.45 if d.dayofweek >= 5 else 1
        for app, w in apps.items():
            for mod, (prix, lat, err) in modeles.items():
                part = {"Petit": 0.5, "Moyen": 0.35, "Grand": 0.15}[mod] * (1.4 if app == "Code" and mod == "Grand" else 1)
                req = int(rng.poisson(120 * w * part * croissance * semaine))
                tok_in = int(req * rng.normal(1400 if app == "Recherche interne" else 650, 80))
                tok_out = int(req * rng.normal(420 if app == "Rédaction" else 230, 30))
                cout = round((tok_in * prix + tok_out * prix * 4) / 1e6 * 1.0, 2)
                latence = round(lat * rng.lognormal(0, 0.15) * (1 + 0.2 * (app == "Recherche interne")), 0)
                erreurs = int(rng.binomial(max(req, 0), err * (1.6 if latence > lat * 1.25 else 1)))
                satisf = round(float(np.clip(4.1 + 0.25 * (mod == "Grand") - 0.0004 * (latence - lat) - 8 * erreurs / max(req, 1) + rng.normal(0, 0.12), 1, 5)), 2)
                rows.append([d.strftime("%Y-%m-%d"), app, mod, req, tok_in, tok_out, cout, latence, erreurs, satisf])
    df = pd.DataFrame(rows, columns=["date", "application", "modele", "requetes", "tokens_entree", "tokens_sortie", "cout_eur", "latence_ms", "erreurs", "satisfaction"])
    save(df, "ia_usage_llm.csv", "Usage d'une API d'IA", "IA & tech",
         "Usage quotidien d'un modèle de langage par quatre applications internes : requêtes, tokens, coût, latence, erreurs, satisfaction.",
         ["Quelle application coûte le plus ?", "Coût par requête selon la taille du modèle",
          "Prévoir le coût mensuel", "La latence pèse-t-elle sur la satisfaction ?"])


# ── RH ────────────────────────────────────────────────────────────────────────────────────────
def rh():
    n = 1800
    dep = rng.choice(["Ventes", "Tech", "Support", "Finance", "Marketing", "RH", "Logistique"], n, p=[0.22, 0.24, 0.16, 0.09, 0.1, 0.05, 0.14])
    age = np.clip(np.round(rng.normal(37, 9, n)), 21, 64).astype(int)
    anc = np.clip(np.round(rng.gamma(2, 2.4, n), 1), 0, age - 20)
    base = pd.Series(dep).map({"Ventes": 38, "Tech": 52, "Support": 31, "Finance": 47, "Marketing": 42, "RH": 40, "Logistique": 30}).to_numpy()
    salaire = np.round((base + 0.7 * anc + 0.25 * (age - 30)) * rng.lognormal(0, 0.12, n) * 1000, -2)
    augmentation = np.round(np.clip(rng.normal(2.5, 1.6, n), 0, 9), 1)
    heures_sup = np.clip(np.round(rng.gamma(1.4, 3, n) + 4 * (dep == "Support")), 0, 40).astype(int)
    tele = rng.choice([0, 1, 2, 3], n, p=[0.25, 0.25, 0.35, 0.15])
    distance = np.round(rng.gamma(2, 9, n), 1)
    satisf = np.clip(np.round(3.6 + 0.12 * augmentation - 0.04 * heures_sup + 0.12 * tele + rng.normal(0, 0.6, n), 1), 1, 5)
    formation = rng.poisson(2, n)
    p = sigmoid(-0.9 - 1.3 * (satisf - 3.4) - 0.18 * augmentation + 0.04 * heures_sup + 0.02 * distance - 0.12 * anc
                - 0.000012 * (salaire - 40000) - 0.15 * formation)
    depart = (rng.random(n) < p).astype(int)
    df = pd.DataFrame({"departement": dep, "age": age, "anciennete_ans": anc, "salaire_annuel": salaire, "augmentation_pct": augmentation,
                       "heures_sup_mois": heures_sup, "teletravail_jours": tele, "distance_km": distance, "formations_an": formation,
                       "satisfaction": satisf, "depart": depart})
    df = holes(df, ["satisfaction"], 0.05)
    save(df, "rh_employes.csv", "Ressources humaines", "RH",
         "1 800 salariés : service, ancienneté, salaire, heures supplémentaires, télétravail, satisfaction et départs.",
         ["Pourquoi les salariés partent-ils ?", "Prédire les départs", "Écarts de salaire entre services",
          "Le télétravail améliore-t-il la satisfaction ?"])


# ── Énergie ───────────────────────────────────────────────────────────────────────────────────
def energie():
    dates = days("2023-01-01", "2026-10-31")
    doy = dates.dayofyear.to_numpy()
    temp = np.round(12.5 - 8.5 * np.cos(2 * np.pi * (doy - 15) / 365) + rng.normal(0, 3, len(dates)), 1)
    ferie = np.isin(dates.strftime("%m-%d"), ["01-01", "05-01", "05-08", "07-14", "08-15", "11-01", "11-11", "12-25"])
    weekend = dates.dayofweek >= 5
    ensoleillement = np.clip(np.round(5.5 - 3.5 * np.cos(2 * np.pi * (doy - 172) / 365 + np.pi) * -1 + rng.normal(0, 2, len(dates)), 1), 0, 15)
    chauffage = np.clip(17 - temp, 0, None) * 210
    clim = np.clip(temp - 24, 0, None) * 160
    conso = np.round((2600 + chauffage + clim) * np.where(weekend | ferie, 0.55, 1) * (1 - 0.012 * np.arange(len(dates)) / 365 * 3)
                     * rng.lognormal(0, 0.05, len(dates)), 0)
    solaire = np.round(ensoleillement * 95 * (1 + 0.3 * (np.arange(len(dates)) > 600)) * rng.lognormal(0, 0.1, len(dates)), 0)
    df = pd.DataFrame({"date": dates.strftime("%Y-%m-%d"), "temperature_c": temp, "ensoleillement_h": ensoleillement,
                       "jour_ferie": ferie.astype(int), "week_end": weekend.astype(int), "consommation_kwh": conso, "production_solaire_kwh": solaire})
    save(df, "energie_batiment.csv", "Énergie d'un bâtiment", "Énergie",
         "Consommation et production solaire quotidiennes d'un bâtiment tertiaire depuis 2023, avec météo et jours fériés.",
         ["Effet de la température sur la consommation", "Prévoir la consommation des prochains mois",
          "Part de l'énergie couverte par le solaire", "Prédire la consommation à partir de la météo"])


# ── Santé ─────────────────────────────────────────────────────────────────────────────────────
def sante():
    n = 2000
    age = np.clip(np.round(rng.normal(52, 15, n)), 18, 90).astype(int)
    sexe = rng.choice(["F", "H"], n)
    imc = np.round(np.clip(rng.normal(26.5, 4.8, n), 16, 48), 1)
    activite = rng.choice(["Faible", "Modérée", "Élevée"], n, p=[0.38, 0.42, 0.2])
    tabac = rng.choice(["Non-fumeur", "Ancien fumeur", "Fumeur"], n, p=[0.56, 0.22, 0.22])
    tension = np.round(108 + 0.45 * age + 0.9 * (imc - 25) + 6 * (tabac == "Fumeur") + rng.normal(0, 11, n))
    glycemie = np.round(0.86 + 0.004 * (age - 40) + 0.012 * (imc - 25) - 0.05 * (activite == "Élevée") + rng.normal(0, 0.12, n), 2)
    chol = np.round(1.75 + 0.006 * age + 0.01 * (imc - 25) + rng.normal(0, 0.3, n), 2)
    score = -0.2 + 0.045 * (age - 52) + 0.08 * (imc - 26) + 0.025 * (tension - 130) + 2.4 * (glycemie - 1) + 0.6 * (tabac == "Fumeur") \
        - 0.45 * (activite == "Élevée") + 0.5 * (chol - 2.1) + rng.normal(0, 0.6, n)
    risque = np.where(score < -0.4, "Faible", np.where(score < 0.9, "Modéré", "Élevé"))
    df = pd.DataFrame({"age": age, "sexe": sexe, "imc": imc, "activite_physique": activite, "tabac": tabac, "tension_systolique": tension,
                       "glycemie_g_l": glycemie, "cholesterol_g_l": chol, "risque_cardio": risque})
    df = holes(df, ["cholesterol_g_l", "glycemie_g_l"], 0.04)
    save(df, "sante_prevention.csv", "Prévention santé", "Santé",
         "2 000 bilans de prévention fictifs : âge, IMC, tension, glycémie, mode de vie et niveau de risque cardiovasculaire.",
         ["Quels facteurs sont liés à un risque élevé ?", "Prédire le niveau de risque", "Tension selon l'âge et le tabac",
          "Profil des patients à risque"])


# ── Immobilier ────────────────────────────────────────────────────────────────────────────────
def immobilier():
    n = 3000
    villes = {"Paris": 10200, "Lyon": 5100, "Bordeaux": 4600, "Nantes": 3900, "Lille": 3600, "Toulouse": 3700, "Marseille": 3500, "Rennes": 4000}
    ville = rng.choice(list(villes), n, p=[0.2, 0.15, 0.12, 0.1, 0.1, 0.12, 0.12, 0.09])
    typ = np.where(rng.random(n) < np.where(ville == "Paris", 0.92, 0.68), "Appartement", "Maison")
    surface = np.round(np.where(typ == "Maison", rng.normal(118, 32, n), rng.lognormal(4.0, 0.38, n)))
    surface = np.clip(surface, 12, 320)
    pieces = np.clip(np.round(surface / 22 + rng.normal(0, 0.6, n)), 1, 9).astype(int)
    annee = np.clip(np.round(rng.normal(1972, 32, n)), 1850, 2025).astype(int)
    dpe = np.where(annee > 2012, rng.choice(list("ABC"), n), np.where(annee > 1990, rng.choice(list("BCDE"), n), rng.choice(list("CDEFG"), n)))
    parking = (rng.random(n) < np.where(typ == "Maison", 0.8, 0.35)).astype(int)
    etage = np.where(typ == "Maison", 0, rng.integers(0, 8, n))
    d = pd.to_datetime("2023-01-01") + pd.to_timedelta(rng.integers(0, 1400, n), unit="D")
    t = (d - pd.Timestamp("2023-01-01")).days.to_numpy() / 365
    prix_m2 = pd.Series(ville).map(villes).to_numpy() * (1 - 0.035 * t + 0.012 * t ** 2) \
        * (1 - 0.0016 * (surface - 60)).clip(0.7, 1.15) * pd.Series(dpe).map({"A": 1.08, "B": 1.05, "C": 1.02, "D": 1, "E": 0.96, "F": 0.9, "G": 0.85}).to_numpy() \
        * (1 + 0.04 * parking) * np.where(typ == "Maison", 0.92, 1) * rng.lognormal(0, 0.09, n)
    prix = np.round(prix_m2 * surface, -3)
    df = pd.DataFrame({"date_vente": d.strftime("%Y-%m-%d"), "ville": ville, "type_bien": typ, "surface_m2": surface.astype(int),
                       "pieces": pieces, "etage": etage, "annee_construction": annee, "dpe": dpe, "parking": parking, "prix_eur": prix}).sort_values("date_vente")
    save(df, "immobilier_ventes.csv", "Ventes immobilières", "Immobilier",
         "3 000 ventes de logements dans huit grandes villes depuis 2023 : surface, pièces, DPE, parking et prix.",
         ["Prix au m² par ville et par DPE", "Prédire le prix d'un logement", "Évolution des prix depuis 2023",
          "Combien vaut une place de parking ?"])


# ── Logistique ────────────────────────────────────────────────────────────────────────────────
def logistique():
    n = 3000
    d = pd.to_datetime("2025-01-01") + pd.to_timedelta(rng.integers(0, 660, n), unit="D")
    transp = rng.choice(["Colissimo", "Chronopost", "DPD", "GLS", "Transporteur régional"], n, p=[0.3, 0.2, 0.2, 0.18, 0.12])
    distance = np.round(rng.gamma(2.2, 160, n))
    poids = np.round(rng.lognormal(1.4, 0.9, n), 1)
    meteo = rng.choice(["Beau", "Pluie", "Neige", "Vent fort"], n, p=[0.62, 0.28, 0.04, 0.06])
    express = (transp == "Chronopost") | (rng.random(n) < 0.1)
    prevu = np.where(express, 1, np.clip(np.round(1 + distance / 350), 1, 5)).astype(int)
    pic = np.isin(d.month, [11, 12])
    retard_j = np.clip(np.round(rng.gamma(0.6, 0.9, n) + 1.2 * (meteo == "Neige") + 0.4 * (meteo == "Pluie") + 0.7 * pic
                                + 0.5 * (transp == "Transporteur régional") - 0.3 * express - 0.5), 0, 9)
    reel = prevu + retard_j
    cout = np.round(4.5 + 0.9 * poids + 0.006 * distance + 7 * express + rng.normal(0, 1, n), 2)
    # Le délai réel n'est pas publié : il donnerait directement la réponse (« fuite » de la cible).
    df = pd.DataFrame({"date_envoi": d.strftime("%Y-%m-%d"), "transporteur": transp, "distance_km": distance.astype(int), "poids_kg": poids,
                       "express": express.astype(int), "meteo": meteo, "delai_prevu_j": prevu,
                       "en_retard": (reel > prevu).astype(int), "cout_eur": cout}).sort_values("date_envoi")
    save(df, "logistique_livraisons.csv", "Livraisons de colis", "Logistique",
         "3 000 expéditions : transporteur, distance, poids, météo, délai prévu, retard et coût.",
         ["Quel transporteur est le plus fiable ?", "Effet de la météo et des fêtes sur les retards",
          "Prédire les retards de livraison", "Coût moyen selon le poids et la distance"])


def existing():
    catalog.insert(0, {"file": "ventes.csv", "label": "Petites ventes", "domain": "Commerce", "rows": 30, "columns": 8,
                       "description": "30 commandes de matériel informatique : produits, régions, montants, satisfaction. Idéal pour un premier essai.",
                       "ideas": ["Quelle région vend le plus ?", "Produits les mieux notés"]})
    catalog.insert(1, {"file": "demo_complet.csv", "label": "Clients et fidélité", "domain": "Marketing", "rows": 402, "columns": 12,
                       "description": "402 clients : canal d'acquisition, segment, commandes, dépenses, satisfaction et départ (churn).",
                       "ideas": ["Quel canal amène les meilleurs clients ?", "Prédire le départ des clients", "Segmenter la clientèle"]})


if __name__ == "__main__":
    for gen in (ecommerce, transactions, credit, bourse, campagnes, newsletter, experiences_ml, usage_llm, rh, energie, sante, immobilier, logistique):
        gen()
    existing()
    order = ["Commerce", "Finance", "Marketing", "IA & tech", "RH", "Énergie", "Santé", "Immobilier", "Logistique"]
    catalog.sort(key=lambda c: order.index(c["domain"]))
    (OUT / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")
    for c in catalog:
        print(f"{c['domain']:<12} {c['file']:<28} {c['rows']:>6} lignes  {c['label']}")

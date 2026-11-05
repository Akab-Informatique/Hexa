// Demo data a brand-new instance can seed once (SEED_PROFILE), so each demo tenant looks like a different firm.
// Real firms use "none": nothing is ever seeded for them.
export interface SeedClient {
  name: string; businessNumber: string; fiscalYearEnd: string; city: string;
  contact: { name: string; email: string; title: string };
  contract?: { name: string; kind: "recurring" | "hourly"; amount?: number; hourlyRate?: number; cycle: "monthly" | "quarterly" | "yearly" };
}
export interface SeedTask { title: string; client: number; dueInDays: number; priority: "low" | "normal" | "high" | "urgent"; checklist?: string[] }
export interface SeedProfile {
  label: string;
  clients: SeedClient[];
  tasks: SeedTask[];
  kb: { title: string; category: string; body: string };
  procedure: { title: string; steps: string[] };
  message: { title: string; body: string };
}

export const PROFILES: Record<string, SeedProfile> = {
  accounting: {
    label: "Cabinet comptable",
    clients: [
      { name: "Boulangerie Dupont inc.", businessNumber: "123456789 RC0001", fiscalYearEnd: "12-31", city: "Joliette", contact: { name: "Marie Dupont", email: "marie@dupont.example", title: "Propriétaire" }, contract: { name: "Mission de compilation", kind: "recurring", amount: 650, cycle: "monthly" } },
      { name: "Construction Lavoie ltée", businessNumber: "234567890 RC0001", fiscalYearEnd: "06-30", city: "Repentigny", contact: { name: "Luc Lavoie", email: "luc@lavoie.example", title: "Président" }, contract: { name: "États financiers annuels", kind: "recurring", amount: 4200, cycle: "yearly" } },
      { name: "Clinique Santé Plus", businessNumber: "345678901 RC0001", fiscalYearEnd: "03-31", city: "Terrebonne", contact: { name: "Dre Anne Roy", email: "anne@santeplus.example", title: "Directrice" }, contract: { name: "Conseil et fiscalité", kind: "hourly", hourlyRate: 165, cycle: "monthly" } },
      { name: "Transport Gagnon", businessNumber: "456789012 RC0001", fiscalYearEnd: "09-30", city: "Mascouche", contact: { name: "Éric Gagnon", email: "eric@gagnon.example", title: "Gestionnaire" } },
    ],
    tasks: [
      { title: "Préparer les états financiers annuels", client: 1, dueInDays: 12, priority: "high", checklist: ["Rapprochements bancaires", "Ajustements de fin d'exercice", "Revue par l'associé"] },
      { title: "Déclaration de TPS/TVQ du trimestre", client: 0, dueInDays: 5, priority: "urgent" },
      { title: "Planification fiscale de fin d'année", client: 2, dueInDays: 30, priority: "normal" },
      { title: "Relancer pour les pièces justificatives manquantes", client: 3, dueInDays: -2, priority: "high" },
    ],
    kb: { title: "Calendrier des échéances fiscales", category: "Fiscalité", body: "Dates clés : TPS/TVQ (trimestrielle ou mensuelle), acomptes provisionnels, T2 (6 mois après la fin d'exercice), TP-1/T1 (30 avril)." },
    procedure: { title: "Ouverture d'un dossier client", steps: ["Valider l'identité et les numéros d'entreprise", "Signer la lettre de mission", "Créer le dossier SharePoint", "Planifier la première rencontre"] },
    message: { title: "Rappel : date limite TPS/TVQ", body: "N'oubliez pas de nous transmettre vos documents avant la fin de la semaine." },
  },
  bookkeeping: {
    label: "Tenue de livres",
    clients: [
      { name: "Café Le Matin", businessNumber: "567890123 RC0001", fiscalYearEnd: "12-31", city: "Saint-Jérôme", contact: { name: "Sophie Tremblay", email: "sophie@lematin.example", title: "Propriétaire" }, contract: { name: "Tenue de livres mensuelle", kind: "recurring", amount: 320, cycle: "monthly" } },
      { name: "Plomberie Bélanger", businessNumber: "678901234 RC0001", fiscalYearEnd: "12-31", city: "Blainville", contact: { name: "Jacques Bélanger", email: "jacques@belanger.example", title: "Propriétaire" }, contract: { name: "Tenue de livres + paie", kind: "recurring", amount: 540, cycle: "monthly" } },
      { name: "Studio Yoga Lune", businessNumber: "789012345 RC0001", fiscalYearEnd: "08-31", city: "Laval", contact: { name: "Camille Lune", email: "camille@lune.example", title: "Directrice" }, contract: { name: "Facturation et paie", kind: "hourly", hourlyRate: 75, cycle: "monthly" } },
    ],
    tasks: [
      { title: "Saisie des transactions du mois", client: 0, dueInDays: 3, priority: "high", checklist: ["Relevés bancaires reçus", "Cartes de crédit", "Factures fournisseurs"] },
      { title: "Paie bimensuelle", client: 1, dueInDays: 1, priority: "urgent" },
      { title: "Remise des retenues à la source", client: 1, dueInDays: 9, priority: "normal" },
      { title: "Rapprochement bancaire", client: 2, dueInDays: 7, priority: "normal" },
    ],
    kb: { title: "Plan comptable standard PME", category: "Tenue de livres", body: "Plan comptable de départ, règles de classement des dépenses et seuils de capitalisation." },
    procedure: { title: "Clôture mensuelle", steps: ["Importer les relevés", "Catégoriser les transactions", "Rapprocher les comptes", "Envoyer le rapport au client"] },
    message: { title: "Nouveau : dépôt des reçus par photo", body: "Vous pouvez maintenant nous envoyer vos reçus directement par courriel." },
  },
  tax: {
    label: "Cabinet de fiscalité",
    clients: [
      { name: "Dr Pierre Fortin (pratique médicale)", businessNumber: "890123456 RC0001", fiscalYearEnd: "12-31", city: "Montréal", contact: { name: "Pierre Fortin", email: "pierre@fortin.example", title: "Médecin" }, contract: { name: "Planification fiscale annuelle", kind: "recurring", amount: 2800, cycle: "yearly" } },
      { name: "Gestion Immobilière Morin", businessNumber: "901234567 RC0001", fiscalYearEnd: "12-31", city: "Longueuil", contact: { name: "Isabelle Morin", email: "isabelle@morin.example", title: "Associée" }, contract: { name: "T2 et planification", kind: "hourly", hourlyRate: 185, cycle: "yearly" } },
      { name: "Famille Gosselin (T1 et fiducie)", businessNumber: "012345678 RC0001", fiscalYearEnd: "12-31", city: "Brossard", contact: { name: "Marc Gosselin", email: "marc@gosselin.example", title: "Client" } },
    ],
    tasks: [
      { title: "Déclaration T2 – dossier Morin", client: 1, dueInDays: 15, priority: "high", checklist: ["Annexes 1, 8, 50", "Revue des acomptes", "Signature électronique"] },
      { title: "T1 et déclarations de fiducie", client: 2, dueInDays: 25, priority: "normal" },
      { title: "Planification de la rémunération (dividendes/salaire)", client: 0, dueInDays: 10, priority: "high" },
      { title: "Réponse à l'avis de cotisation", client: 0, dueInDays: -1, priority: "urgent" },
    ],
    kb: { title: "Seuils et taux d'imposition (référence)", category: "Fiscalité", body: "Taux et seuils à jour pour les sociétés (DPE, taux général) et les particuliers (QC/CA). À valider chaque année." },
    procedure: { title: "Revue d'une déclaration avant production", steps: ["Vérifier la concordance avec les états financiers", "Contrôler les crédits et reports", "Revue de l'associé", "Transmission électronique et accusé"] },
    message: { title: "Rappel : documents fiscaux de fin d'année", body: "Transmettez vos relevés (feuillets T4, T5, RL-3) pour planifier votre production." },
  },
};

// Single source of truth for access rights. Used by the API (enforcement), the admin
// matrix and the sidebar (visibility). Key scheme: <module>.<page?>.<action>.
// Action ladder: view < edit < manage (manage = act on other people's work / delete).

export type Audience = "staff" | "client";
export interface Label { fr: string; en: string }
export interface PermDef { key: string; label: Label; description?: Label }
export interface ModuleDef {
  key: string;
  audience: Audience;
  /** Sidebar section the module sits in (the admin matrix groups by this). */
  section: "team" | "mytools" | "command" | "management" | "accounting" | "admin" | "clientportal";
  label: Label;
  permissions: PermDef[];
}

const p = (key: string, fr: string, en: string): PermDef => ({ key, label: { fr, en } });

export const MODULES: ModuleDef[] = [
  {
    key: "team", audience: "staff", section: "team", label: { fr: "Équipe", en: "Team" },
    permissions: [
      p("team.dashboard.view", "Voir les tableaux de bord", "View dashboards"),
      p("team.dashboard.edit", "Personnaliser ses tableaux de bord", "Customize own dashboards"),
      p("team.dashboard.share", "Partager des tableaux de bord", "Share dashboards"),
      p("team.dashboard.lock", "Verrouiller des tableaux de bord partagés", "Lock shared dashboards"),
      p("team.dashboard.manage", "Administrer les tableaux de bord partagés (sans en être le propriétaire)", "Administer shared dashboards (without owning them)"),
      p("team.meeting.view", "Voir la rencontre d'équipe", "View the team meeting"),
      p("team.meeting.edit", "Ajouter des points à la rencontre", "Add meeting points"),
      p("team.meeting.manage", "Gérer la rencontre d'équipe", "Manage the team meeting"),
    ],
  },
  {
    key: "mytools", audience: "staff", section: "mytools", label: { fr: "Mes outils", en: "My tools" },
    permissions: [
      p("mytools.calendar.use", "Calendrier O365", "O365 calendar"),
      p("mytools.mail.use", "Boîte de réception Outlook", "Outlook inbox"),
      p("mytools.timesheet.use", "Feuille de temps", "Timesheet"),
      p("mytools.timesheet.approve", "Approuver les feuilles de temps", "Approve timesheets"),
      p("mytools.timesheet.manage", "Saisir et corriger le temps des autres, rapports", "Enter and correct others' time, reports"),
      p("mytools.expenses.use", "Dépenses", "Expenses"),
      p("mytools.expenses.approve", "Approuver les dépenses", "Approve expenses"),
      p("mytools.kb.view", "Voir la base de connaissances", "View the knowledge base"),
      p("mytools.kb.edit", "Modifier la base de connaissances", "Edit the knowledge base"),
      p("mytools.procedures.view", "Voir les procédures", "View procedures"),
      p("mytools.procedures.edit", "Modifier les procédures", "Edit procedures"),
      p("mytools.procedures.manage", "Gérer les procédures", "Manage procedures"),
    ],
  },
  {
    key: "command", audience: "staff", section: "command", label: { fr: "Centre de commande", en: "Command center" },
    permissions: [
      p("command.board.view", "Voir le babillard", "View the message board"),
      p("command.board.post", "Publier un message", "Post a message"),
      p("command.board.email", "Envoyer un message par courriel", "Email a message"),
      p("command.board.manage", "Gérer le babillard", "Manage the message board"),
      p("command.pipeline.view", "Voir le pipeline", "View the pipeline"),
      p("command.pipeline.edit", "Modifier ses tâches du pipeline", "Edit own pipeline tasks"),
      p("command.pipeline.manage", "Gérer le pipeline de l'équipe", "Manage the team pipeline"),
    ],
  },
  {
    key: "tasks", audience: "staff", section: "management", label: { fr: "Tâches", en: "Tasks" },
    permissions: [
      p("tasks.view", "Voir les tâches", "View tasks"),
      p("tasks.edit", "Modifier les tâches", "Edit tasks"),
      p("tasks.manage", "Gérer toutes les tâches", "Manage all tasks"),
    ],
  },
  {
    key: "docs", audience: "staff", section: "management", label: { fr: "Documentation", en: "Documentation" },
    permissions: [
      p("docs.view", "Parcourir les dossiers SharePoint autorisés", "Browse the SharePoint folders they are allowed"),
      p("docs.edit", "Ajouter, créer et supprimer dans les dossiers en modification", "Upload, create and delete in folders with edit access"),
      p("docs.access.manage", "Gérer l'accès aux dossiers (selon son propre accès)", "Manage folder access (up to their own access)"),
      p("docs.manage", "Voir toutes les bibliothèques et gérer tous les accès", "See every library and manage all access"),
    ],
  },
  {
    key: "clients", audience: "staff", section: "management", label: { fr: "Clients", en: "Clients" },
    permissions: [
      p("clients.view", "Voir les clients", "View clients"),
      p("clients.edit", "Modifier les clients", "Edit clients"),
      p("clients.manage", "Gérer les clients (désactiver, supprimer)", "Manage clients (deactivate, delete)"),
      p("clients.contacts.view", "Voir les contacts", "View contacts"),
      p("clients.contacts.edit", "Modifier les contacts", "Edit contacts"),
      p("clients.contracts.view", "Voir les contrats", "View contracts"),
      p("clients.contracts.edit", "Modifier les contrats", "Edit contracts"),
      p("clients.users.manage", "Gérer les accès portail des clients", "Manage client portal access"),
      p("clients.billing.manage", "Modifier la facturation des clients (courriel, délais, taux, forfaits)", "Edit client billing (email, terms, rates, packages)"),
      p("clients.tracking.view", "Voir le suivi fiscal des clients", "View the clients' tax follow-up"),
      p("clients.tracking.edit", "Modifier le suivi fiscal des clients", "Edit the clients' tax follow-up"),
      p("clients.layout.manage", "Régler l'ordre des onglets du dossier client", "Set the order of the client page tabs"),
    ],
  },
  {
    key: "accounting", audience: "staff", section: "accounting", label: { fr: "Comptabilité interne", en: "Internal accounting" },
    permissions: [
      p("accounting.invoices.view", "Voir les factures", "View invoices"),
      p("accounting.invoices.edit", "Créer et modifier les factures", "Create and edit invoices"),
      p("accounting.invoices.manage", "Envoyer et annuler les factures", "Send and void invoices"),
      p("accounting.approvals.view", "Voir le travail à facturer", "View work to bill"),
      p("accounting.approvals.manage", "Approuver le travail à facturer", "Approve work to bill"),
      p("accounting.vendors.view", "Voir les fournisseurs", "View vendors"),
      p("accounting.vendors.manage", "Gérer les fournisseurs et paiements", "Manage vendors and payments"),
    ],
  },
  {
    key: "services", audience: "staff", section: "management", label: { fr: "Services", en: "Services" },
    permissions: [
      p("services.view", "Voir le catalogue de services", "View the service catalogue"),
      p("services.manage", "Gérer le catalogue de services", "Manage the service catalogue"),
    ],
  },
  {
    key: "hr", audience: "staff", section: "accounting", label: { fr: "Ressources humaines", en: "Human resources" },
    permissions: [
      p("hr.view", "Voir les employés", "View staff"),
      p("hr.manage", "Gérer les employés", "Manage staff"),
    ],
  },
  {
    key: "admin", audience: "staff", section: "admin", label: { fr: "Administration", en: "Administration" },
    permissions: [
      p("admin.users.view", "Voir les utilisateurs", "View users"),
      p("admin.users.manage", "Créer et modifier les utilisateurs", "Create and edit users"),
      p("admin.groups.manage", "Gérer les groupes et accès", "Manage groups and access"),
      p("admin.integrations.view", "Voir les intégrations", "View integrations"),
      p("admin.integrations.manage", "Configurer les intégrations", "Configure integrations"),
      p("admin.branding.view", "Voir l'image de marque et les modules", "View branding and modules"),
      p("admin.classes.manage", "Gérer les classifications de clients", "Manage client classifications"),
      p("admin.time.manage", "Gérer les types de temps et de dépenses", "Manage time and expense types"),
      p("admin.audit.view", "Voir le journal d'activité", "View the activity log"),
    ],
  },
  {
    key: "clientportal", audience: "client", section: "clientportal", label: { fr: "Portail client", en: "Client portal" },
    permissions: [
      p("clientportal.view", "Accéder au portail", "Access the portal"),
      p("clientportal.board.view", "Voir le babillard", "See the message board"),
      p("clientportal.invoices.view", "Voir ses factures et son relevé", "See its invoices and statement"),
      p("clientportal.contracts.view", "Voir ses contrats", "See its contracts"),
      p("clientportal.docs.view", "Voir ses documents", "See its documents"),
    ],
  },
];

export const ALL_PERMISSIONS = MODULES.flatMap((m) => m.permissions.map((x) => ({ ...x, module: m.key, audience: m.audience })));
const AUDIENCE_OF = new Map(ALL_PERMISSIONS.map((x) => [x.key, x.audience]));
export const isKnownPermission = (key: string) => AUDIENCE_OF.has(key);
export const permissionsFor = (audience: Audience): string[] => ALL_PERMISSIONS.filter((x) => x.audience === audience).map((x) => x.key);

/**
 * Effective rights = group rights + per-user allows - per-user denies, limited to the user's
 * audience. A master user holds every right of their audience. Unknown keys are dropped.
 */
export function effectivePermissions(input: {
  audience: Audience;
  master: boolean;
  groupPermissions: string[][];
  allow: string[];
  deny: string[];
}): string[] {
  if (input.master) return permissionsFor(input.audience);
  const set = new Set<string>([...input.groupPermissions.flat(), ...input.allow]);
  for (const d of input.deny) set.delete(d);
  return [...set].filter((k) => AUDIENCE_OF.get(k) === input.audience).sort();
}

/** Non-master users may only hand out rights they hold themselves (no privilege escalation). */
export function ungrantable(granterRights: string[], granterIsMaster: boolean, wanted: string[]): string[] {
  if (granterIsMaster) return [];
  const held = new Set(granterRights);
  return wanted.filter((k) => !held.has(k));
}

export const hasPermission = (rights: readonly string[], key: string) => rights.includes(key);

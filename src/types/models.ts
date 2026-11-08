// Modelos de dados do cofre

export type PasswordStrength = 'critical' | 'weak' | 'medium' | 'strong' | 'very_strong';

export type CredentialCategory =
  | 'social'
  | 'email'
  | 'finance'
  | 'work'
  | 'shopping'
  | 'entertainment'
  | 'development'
  | 'government'
  | 'education'
  | 'health'
  | 'travel'
  | 'other';

export interface CustomField {
  id: string;
  label: string;
  value: string;
  type: 'text' | 'hidden' | 'url' | 'email';
}

export interface ServiceIcon {
  kind: 'auto' | 'glyph' | 'image';
  glyph?: string;
  color?: string;
  image?: string; // data URI (armazenada no banco cifrado)
}

export interface Credential {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  category: CredentialCategory;
  folderId: string | null;
  favorite: boolean;
  customFields: CustomField[];
  icon: ServiceIcon;
  /** Contador de acessos (cópia da senha ou preenchimento automático), usado na ordenação inteligente. */
  usageCount: number;
  lastUsedAt: string | null;
  /** Último uso de fato (cópia da senha ou preenchimento), sem contar a simples abertura do detalhe. */
  lastUsageAt?: string | null;
  passwordChangedAt: string;
  /** Data de validade definida pelo usuário. Vencida, a credencial fica inativa. */
  expiresAt: string | null;
  /** Marcada como inativa ao vencer (não aparece no preenchimento automático). */
  inactive: boolean;
  /** Prazo próprio para trocar a senha, em dias (sobrepõe o padrão dos ajustes). */
  maxPasswordAgeDays: number | null;
  /** Últimas senhas usadas neste registro, da mais recente para a mais antiga, no máximo 10. */
  passwordHistory: PasswordHistoryEntry[];
  /** Domínios e subdomínios associados para o preenchimento automático. */
  associatedDomains: string[];
  /** Pacotes Android associados (preenchimento em apps). */
  androidPackages: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PasswordHistoryEntry {
  password: string;
  /** Quando essa senha deixou de ser a atual. */
  changedAt: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  icon: string;
  order: number;
  /** Regras de segurança da pasta; valem também para as subpastas. */
  policy?: FolderPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface FolderPolicy {
  /** Pede a senha mestra ou a biometria antes de mostrar/copiar a senha. */
  requireReauth: boolean;
  /** Força mínima exigida das senhas salvas na pasta. */
  minStrength: PasswordStrength | null;
  /** Prazo máximo da senha (dias) para as credenciais da pasta. */
  maxAgeDays: number | null;
  /** Não preencher automaticamente em outros apps (só cópia manual). */
  blockAutofill: boolean;
  /** Não exportar o conteúdo da pasta (CSV/JSON/backup legível). */
  blockExport: boolean;
  /** Tempo de limpeza da área de transferência específico (segundos). */
  clipboardSeconds: number | null;
}

export const DefaultFolderPolicy: FolderPolicy = {
  requireReauth: false,
  minStrength: null,
  maxAgeDays: null,
  blockAutofill: false,
  blockExport: false,
  clipboardSeconds: null,
};

// -----------------------------------------------------------------------------
// Notas seguras
// -----------------------------------------------------------------------------
export type NoteCategory = 'recovery_key' | 'wifi' | 'bank_info' | 'document' | 'personal' | 'other';

export interface NoteAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Conteúdo em base64, guardado dentro do banco SQLCipher. */
  data: string;
}

export interface SecureNote {
  id: string;
  title: string;
  content: string;
  category: NoteCategory;
  folderId: string | null;
  favorite: boolean;
  attachments: NoteAttachment[];
  createdAt: string;
  updatedAt: string;
}

export const NoteCategoryLabels: Record<NoteCategory, string> = {
  recovery_key: 'Chave de recuperação',
  wifi: 'Wi-Fi',
  bank_info: 'Dados bancários',
  document: 'Documento',
  personal: 'Pessoal',
  other: 'Outros',
};

// -----------------------------------------------------------------------------
// Formulários: cartões, endereços e identidades
// -----------------------------------------------------------------------------
export type FormKind = 'card' | 'address' | 'identity';
export type CardBrand = 'visa' | 'mastercard' | 'elo' | 'amex' | 'hipercard' | 'diners' | 'other';

export interface PaymentCard {
  id: string;
  kind: 'card';
  label: string;
  holder: string;
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  brand: CardBrand;
  createdAt: string;
  updatedAt: string;
}

export interface Address {
  id: string;
  kind: 'address';
  label: string;
  fullName: string;
  zipCode: string;
  street: string;
  number: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
  country: string;
  phone: string;
  /** Ponto de referência. Opcional: registros antigos não têm. */
  reference?: string;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Identity {
  id: string;
  kind: 'identity';
  label: string;
  fullName: string;
  email: string;
  phone: string;
  cpf: string;
  rg: string;
  birthDate: string;
  company: string;
  createdAt: string;
  updatedAt: string;
}

export type FormItem = PaymentCard | Address | Identity;

// -----------------------------------------------------------------------------
// Segurança: alertas e histórico de acessos
// -----------------------------------------------------------------------------
export type AlertSeverity = 'info' | 'warning' | 'danger';

export type AlertType =
  | 'login_failed'
  | 'breach'
  | 'weak'
  | 'reused'
  | 'old'
  | 'expired'
  | 'phishing'
  | 'ssl'
  | 'integrity'
  | 'backup'
  | 'sync'
  | 'policy'
  | 'new_device';

export interface SecurityAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  /** Item relacionado (id de credencial), quando houver. */
  ref?: string | null;
  createdAt: string;
  read: boolean;
}

export type AccessMethod = 'password' | 'biometric' | 'recovery' | 'totp';

export interface AccessLogEntry {
  id: string;
  at: string;
  method: AccessMethod;
  success: boolean;
  /** Detalhe legível (ex.: "Senha incorreta", "Código 2FA inválido"). */
  detail?: string;
  /** Modelo do aparelho e rede (sem GPS). */
  device?: string;
}

/** Tempo mínimo de retenção do histórico de acessos (: 30 dias). */
export const ACCESS_LOG_RETENTION_DAYS = 90;

export type ChangeType = 'create' | 'update' | 'password' | 'restore' | 'move' | 'import' | 'sync';

export interface CredentialVersion {
  id: string;
  credentialId: string;
  changeType: ChangeType;
  changedAt: string;
  /** Ordem monotônica (desempate quando duas versões têm o mesmo horário). */
  seq?: number;
  summary: string;
  snapshot: Credential;
}

export type SortMode = 'smart' | 'recent' | 'alpha' | 'usage' | 'risk';

export interface AppSettings {
  biometricEnabled: boolean;
  /** Bloqueio por inatividade, padrão 5 min. */
  autoLockMinutes: number;
  /** Reautenticação ao voltar do segundo plano. */
  reauthAfterMinutes: number;
  /** Limpeza da área de transferência, padrão 30 s. */
  clipboardSeconds: number;
  /** Teclado virtual seguro para a senha mestra. */
  secureKeyboard: boolean;
  /** Bloqueio por proximidade/acelerômetro. */
  proximityLock: boolean;
  /** Bloquear imediatamente ao minimizar/desligar a tela. */
  lockOnBackground: boolean;
  sortMode: SortMode;
  // --- Integração, segurança e conta ---
  /** Prazo padrão para sugerir a troca de senha. */
  passwordMaxAgeDays: number;
  /** Credencial vencida fica inativa automaticamente. */
  autoInactiveOnExpire: boolean;
  /** Backup cifrado automático. */
  autoBackup: boolean;
  backupIntervalDays: number;
  /** Envia também ao Google Drive (escopo drive.file) quando a conta estiver conectada. */
  googleDriveBackup: boolean;
  /** Sincronização com o servidor Node.js. */
  syncEnabled: boolean;
  serverUrl: string;
  /** Verificação automática de vazamentos (HIBP, k-anonimato). */
  breachAutoCheck: boolean;
  /** Notificações do sistema para alertas de segurança. */
  securityNotifications: boolean;
  /** Preenchimento automático em outros apps. */
  autofillEnabled: boolean;
  /** Verifica a URL/domínio antes de preencher. */
  autofillVerifyUrl: boolean;
  /** Ponte com a extensão de navegador. */
  browserBridge: boolean;
}

export const DefaultSettings: AppSettings = {
  biometricEnabled: false,
  autoLockMinutes: 5,
  reauthAfterMinutes: 5,
  clipboardSeconds: 30,
  secureKeyboard: true,
  proximityLock: true,
  lockOnBackground: false,
  sortMode: 'smart',
  passwordMaxAgeDays: 90,
  autoInactiveOnExpire: true,
  autoBackup: true,
  backupIntervalDays: 7,
  googleDriveBackup: false,
  syncEnabled: false,
  serverUrl: 'http://10.0.2.2:3000',
  breachAutoCheck: true,
  securityNotifications: true,
  autofillEnabled: true,
  autofillVerifyUrl: true,
  browserBridge: false,
};

export type ProfileType = 'personal' | 'professional';

/** Perfil: cada perfil tem banco, chaves, biometria e ajustes próprios. */
export interface Profile {
  id: string;
  name: string;
  type?: ProfileType;
  color: string;
  createdAt: string;
}

export const CategoryLabels: Record<CredentialCategory, string> = {
  social: 'Redes Sociais',
  email: 'E-mail',
  finance: 'Finanças',
  work: 'Trabalho',
  shopping: 'Compras',
  entertainment: 'Entretenimento',
  development: 'Desenvolvimento',
  government: 'Governo',
  education: 'Educação',
  health: 'Saúde',
  travel: 'Viagem',
  other: 'Outros',
};

export const CategoryIcons: Record<CredentialCategory, string> = {
  social: 'users',
  email: 'mail',
  finance: 'dollar-sign',
  work: 'briefcase',
  shopping: 'shopping-bag',
  entertainment: 'film',
  development: 'code',
  government: 'flag',
  education: 'book-open',
  health: 'heart',
  travel: 'map',
  other: 'folder',
};

export const StrengthLabels: Record<PasswordStrength, string> = {
  critical: 'Crítica',
  weak: 'Fraca',
  medium: 'Média',
  strong: 'Forte',
  very_strong: 'Muito forte',
};

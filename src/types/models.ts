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
  /** Contador de acessos (cópia da senha), usado na ordenação inteligente. */
  usageCount: number;
  lastUsedAt: string | null;
  passwordChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  icon: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export type ChangeType = 'create' | 'update' | 'password' | 'restore' | 'move';

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

export type SortMode = 'smart' | 'recent' | 'alpha' | 'usage';

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
};

export interface Profile {
  id: string;
  name: string;
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

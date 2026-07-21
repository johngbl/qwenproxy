import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";

interface PriorityData {
  accountOrder: string[];
  lastUpdated: number;
}

const DATA_DIR = resolve("data");
const PRIORITY_FILE = join(DATA_DIR, "account-priority.json");

let priorityCache: PriorityData | null = null;

function loadPriority(): PriorityData {
  if (priorityCache) return priorityCache;

  try {
    if (existsSync(PRIORITY_FILE)) {
      const data = JSON.parse(readFileSync(PRIORITY_FILE, "utf-8"));
      priorityCache = {
        accountOrder: data.accountOrder || [],
        lastUpdated: data.lastUpdated || 0,
      };
      return priorityCache!;
    }
  } catch (err) {
    console.error("❌ [AccountPriority] Failed to load priority file:", (err as Error).message);
  }

  priorityCache = { accountOrder: [], lastUpdated: 0 };
  return priorityCache;
}

function savePriority(data: PriorityData): void {
  try {
    writeFileSync(PRIORITY_FILE, JSON.stringify(data, null, 2), "utf-8");
    priorityCache = data;
  } catch (err) {
    console.error("❌ [AccountPriority] Failed to save priority file:", (err as Error).message);
  }
}

/**
 * Reordena contas: conta que funcionou vai para o topo
 */
export function markAccountSuccessful(accountId: string): void {
  const data = loadPriority();
  
  // Remove se já existe
  data.accountOrder = data.accountOrder.filter(id => id !== accountId);
  
  // Adiciona no topo
  data.accountOrder.unshift(accountId);
  data.lastUpdated = Date.now();
  
  savePriority(data);
}

/**
 * Reordena contas: conta que falhou vai para o final
 */
export function markAccountFailed(accountId: string): void {
  const data = loadPriority();
  
  // Remove se já existe
  data.accountOrder = data.accountOrder.filter(id => id !== accountId);
  
  // Adiciona no final
  data.accountOrder.push(accountId);
  data.lastUpdated = Date.now();
  
  savePriority(data);
}

/**
 * Retorna contas ordenadas por prioridade (melhores primeiro)
 */
export function getAccountsByPriority<T extends { id: string }>(accounts: T[]): T[] {
  const data = loadPriority();
  
  if (data.accountOrder.length === 0) {
    return accounts;
  }
  
  // Cria mapa de prioridade (menor índice = maior prioridade)
  const priorityMap = new Map<string, number>();
  data.accountOrder.forEach((id, index) => {
    priorityMap.set(id, index);
  });
  
  // Ordena: contas na lista de prioridade vêm primeiro, depois as que não estão na lista
  return [...accounts].sort((a, b) => {
    const priorityA = priorityMap.get(a.id);
    const priorityB = priorityMap.get(b.id);
    
    // Ambos têm prioridade definida
    if (priorityA !== undefined && priorityB !== undefined) {
      return priorityA - priorityB;
    }
    
    // Apenas A tem prioridade
    if (priorityA !== undefined) {
      return -1;
    }
    
    // Apenas B tem prioridade
    if (priorityB !== undefined) {
      return 1;
    }
    
    // Nenhum tem prioridade, mantém ordem original
    return 0;
  });
}

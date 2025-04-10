// Оновлений coreService.js
import EventEmitter from '../battle-history/scripts/eventEmitter.js';
import { GAME_POINTS, STATS } from '../battle-history/scripts/constants.js';

class CoreService {
  constructor() {
    try {
      this.sdk = new WotstatWidgetsSdk.WidgetSDK();
    } catch (error) {
      console.error('Failed to initialize SDK:', error);
      throw error;
    }

    const savedState = localStorage.getItem('gameState');
    if (savedState) {
      const state = JSON.parse(savedState);
      this.BattleStats = state.BattleStats || {};
      this.PlayersInfo = state.PlayersInfo || {};
      this.curentPlayerId = state.curentPlayerId || null;
      this.curentArenaId = state.curentArenaId || null;
      this.curentVehicle = state.curentVehicle || null;
      this.isInPlatoon = state.isInPlatoon || false;
    } else {
      this.BattleStats = {};
      this.PlayersInfo = {};
      this.curentPlayerId = this.sdk.data.player.id.value;
      this.curentArenaId = null;
      this.curentVehicle = null;
      this.isInPlatoon = false;
    }

    // Додаємо лічильник для регулярної синхронізації
    this.syncCounter = 0;
    this.syncInterval = null;
    this.lastSyncTime = 0;
    this.minSyncInterval = 15000; // Мінімальний інтервал синхронізації - 15 секунд

    this.setupSDKListeners();
    this.eventsCore = new EventEmitter();
    this.loadFromServer();
    this.startSyncTimer(); // Запускаємо таймер регулярної синхронізації
  }

  // Новий метод для запуску регулярної синхронізації
  startSyncTimer() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    
    // Запускаємо синхронізацію кожні 30 секунд
    this.syncInterval = setInterval(() => {
      this.syncCounter++;
      console.log(`Регулярна синхронізація #${this.syncCounter}`);
      
      if (this.isExistsRecord() && this.isInPlatoon) {
        const now = Date.now();
        if (now - this.lastSyncTime > this.minSyncInterval) {
          this.serverDataLoadOtherPlayers();
          this.lastSyncTime = now;
        }
      }
    }, 30000);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getRandomDelay() {
    const min = 50;
    const max = 100;
    return this.sleep(Math.floor(Math.random() * (max - min + 5)) + min);
  }

  setupSDKListeners() {
    this.sdk.data.hangar.isInHangar.watch(this.handleHangarStatus.bind(this));
    this.sdk.data.hangar.vehicle.info.watch(this.handleHangarVehicle.bind(this));
    this.sdk.data.platoon.isInPlatoon.watch(this.handlePlatoonStatus.bind(this));
    this.sdk.data.battle.arena.watch(this.handleArena.bind(this));
    this.sdk.data.battle.isInBattle.watch(this.handleBattleStatus.bind(this));
    this.sdk.data.battle.onDamage.watch(this.handleOnAnyDamage.bind(this));
    this.sdk.data.battle.onPlayerFeedback.watch(this.handlePlayerFeedback.bind(this));
    this.sdk.data.battle.onBattleResult.watch(this.handleBattleResult.bind(this));
    
    // Додаємо нові обробники для кращого відстеження
    this.sdk.data.battle.efficiency.damage.watch(this.handleEfficiencyDamage.bind(this));
    this.sdk.data.battle.efficiency.kills.watch(this.handleEfficiencyKills.bind(this));
    this.sdk.data.battle.personal.damageDealt.watch(this.handlePersonalDamage.bind(this));
    this.sdk.data.battle.onKilled.watch(this.handleOnKilled.bind(this));
  }

  // Новий метод для обробки стану бою
  handleBattleStatus(isInBattle) {
    if (isInBattle && this.isInPlatoon) {
      // Якщо гравець увійшов у бій і перебуває у взводі, запускаємо частішу синхронізацію
      if (this.syncInterval) {
        clearInterval(this.syncInterval);
      }
      
      this.syncInterval = setInterval(() => {
        this.syncCounter++;
        console.log(`Синхронізація в бою #${this.syncCounter}`);
        
        if (this.isExistsRecord()) {
          const now = Date.now();
          if (now - this.lastSyncTime > this.minSyncInterval) {
            this.serverDataLoadOtherPlayers();
            this.lastSyncTime = now;
          }
        }
      }, 15000); // У бою синхронізуємося частіше - кожні 15 секунд
    } else if (!isInBattle) {
      // Повертаємося до звичайного режиму синхронізації
      this.startSyncTimer();
    }
  }

  // Новий метод для обробки шкоди з efficiency
  handleEfficiencyDamage(newValue, oldValue) {
    if (!this.curentArenaId || !this.isInPlatoon) return;
    
    console.log('Efficiency damage updated:', { newValue, oldValue });
    
    const additionalDamage = newValue - (oldValue || 0);
    if (additionalDamage > 0) {
      // Оновлюємо дані для поточного гравця
      const playerId = this.curentPlayerId;
      if (!this.BattleStats[this.curentArenaId].players[playerId]) {
        this.initializeBattleStats(this.curentArenaId, playerId);
      }
      
      this.BattleStats[this.curentArenaId].players[playerId].damage += additionalDamage;
      this.BattleStats[this.curentArenaId].players[playerId].points += additionalDamage * GAME_POINTS.POINTS_PER_DAMAGE;
      
      // Зберігаємо та оновлюємо дані
      if (this.isExistsRecord()) {
        this.saveState();
        this.eventsCore.emit('statsUpdated');
        
        const now = Date.now();
        if (now - this.lastSyncTime > this.minSyncInterval) {
          this.serverDataSave();
          this.lastSyncTime = now;
        }
      }
    }
  }

  // Новий метод для обробки фрагів з efficiency
  handleEfficiencyKills(newValue, oldValue) {
    if (!this.curentArenaId || !this.isInPlatoon) return;
    
    console.log('Efficiency kills updated:', { newValue, oldValue });
    
    const additionalKills = newValue - (oldValue || 0);
    if (additionalKills > 0) {
      // Оновлюємо дані для поточного гравця
      const playerId = this.curentPlayerId;
      if (!this.BattleStats[this.curentArenaId].players[playerId]) {
        this.initializeBattleStats(this.curentArenaId, playerId);
      }
      
      this.BattleStats[this.curentArenaId].players[playerId].kills += additionalKills;
      this.BattleStats[this.curentArenaId].players[playerId].points += additionalKills * GAME_POINTS.POINTS_PER_FRAG;
      
      // Зберігаємо та оновлюємо дані
      if (this.isExistsRecord()) {
        this.saveState();
        this.eventsCore.emit('statsUpdated');
        
        const now = Date.now();
        if (now - this.lastSyncTime > this.minSyncInterval) {
          this.serverDataSave();
          this.lastSyncTime = now;
        }
      }
    }
  }

  // Оновлений метод для personal.damageDealt
  handlePersonalDamage(newValue, oldValue) {
    if (!this.curentArenaId || !this.isInPlatoon) return;
    
    console.log('Personal damage updated:', { newValue, oldValue });
    
    if (newValue > 0) {
      const playerId = this.curentPlayerId;
      if (!this.BattleStats[this.curentArenaId].players[playerId]) {
        this.initializeBattleStats(this.curentArenaId, playerId);
      }
      
      // Встановлюємо нове значення шкоди та перераховуємо очки
      const currentDamage = this.BattleStats[this.curentArenaId].players[playerId].damage;
      if (newValue > currentDamage) {
        this.BattleStats[this.curentArenaId].players[playerId].damage = newValue;
        this.BattleStats[this.curentArenaId].players[playerId].points = 
          newValue * GAME_POINTS.POINTS_PER_DAMAGE + 
          (this.BattleStats[this.curentArenaId].players[playerId].kills || 0) * GAME_POINTS.POINTS_PER_FRAG;
        
        // Зберігаємо та оновлюємо дані
        if (this.isExistsRecord()) {
          this.saveState();
          this.eventsCore.emit('statsUpdated');
          
          const now = Date.now();
          if (now - this.lastSyncTime > this.minSyncInterval) {
            this.serverDataSave();
            this.lastSyncTime = now;
          }
        }
      }
    }
  }

  // Новий обробник для onKilled
  handleOnKilled(data) {
    if (!this.curentArenaId || !this.isInPlatoon || !data || !data.attacker || !data.attacker.playerId) return;
    
    console.log('onKilled event:', data);
    
    const attackerId = data.attacker.playerId;
    // Перевіряємо, чи вбивця є гравцем взводу
    if (this.PlayersInfo[attackerId]) {
      console.log(`Фраг від члена взводу: ${this.PlayersInfo[attackerId]}`);
      
      if (!this.BattleStats[this.curentArenaId].players[attackerId]) {
        this.initializeBattleStats(this.curentArenaId, attackerId);
      }
      
      // Додаємо фраг і очки
      this.BattleStats[this.curentArenaId].players[attackerId].kills += 1;
      this.BattleStats[this.curentArenaId].players[attackerId].points += GAME_POINTS.POINTS_PER_FRAG;
      
      // Зберігаємо та оновлюємо дані
      if (this.isExistsRecord()) {
        this.saveState();
        this.eventsCore.emit('statsUpdated');
        
        const now = Date.now();
        if (now - this.lastSyncTime > this.minSyncInterval) {
          this.serverDataSave();
          this.lastSyncTime = now;
        }
      }
    }
  }

  saveState() {
    const state = {
      BattleStats: this.BattleStats,
      PlayersInfo: this.PlayersInfo,
      curentPlayerId: this.curentPlayerId,
      curentArenaId: this.curentArenaId,
      curentVehicle: this.curentVehicle,
      isInPlatoon: this.isInPlatoon
    };
    localStorage.setItem('gameState', JSON.stringify(state));
  }

  clearState() {
    localStorage.removeItem('gameState');

    this.BattleStats = {};
    this.PlayersInfo = {};
    this.curentPlayerId = this.sdk.data.player.id.value;
    this.curentArenaId = null;
    this.curentVehicle = null;
    this.isInPlatoon = false;
  }

  initializeBattleStats(arenaId, playerId) {
    if (!this.BattleStats[arenaId]) {
      this.BattleStats[arenaId] = {
        startTime: Date.now(),
        duration: 0,
        win: -1,
        mapName: 'Unknown Map',
        players: {}
      };
    }

    if (!this.BattleStats[arenaId].players[playerId]) {
      this.BattleStats[arenaId].players[playerId] = {
        name: this.PlayersInfo[playerId] || 'Unknown Player',
        damage: 0,
        kills: 0,
        points: 0,
        vehicle: this.curentVehicle || 'Unknown Vehicle'
      };
    }
  }

  getPlayer(id) {
    return this.PlayersInfo[id] || null;
  }

  getPlayersIds() {
    return Object.keys(this.PlayersInfo || {})
      .filter(key => !isNaN(key))
      .map(Number);
  }
  
  isExistsRecord() {
    const playersIds = this.getPlayersIds();
    return (playersIds.includes(this.curentPlayerId));
  }
  
  findBestAndWorstBattle() {
    const allBattles = Object.entries(this.BattleStats).map(([arenaId, battle]) => ({
      id: arenaId,
      ...battle
    }));
    
    if (!allBattles || allBattles.length === 0) {
      return { bestBattle: null, worstBattle: null };
    }

    // Фільтруємо тільки завершені бої (не "в бою")
    const completedBattles = allBattles.filter(battle => battle.win !== -1);
    
    if (completedBattles.length === 0) {
      return { bestBattle: null, worstBattle: null };
    }

    try {
      // Знаходимо найгірший і найкращий бій за загальними очками
      let worstBattle = completedBattles[0];
      let bestBattle = completedBattles[0];
      let worstBattlePoints = this.calculateBattlePoints(worstBattle);
      let bestBattlePoints = worstBattlePoints;

      completedBattles.forEach(battle => {
        try {
          const battlePoints = this.calculateBattlePoints(battle);
          
          // Перевіряємо, чи очки менші за поточного найгіршого бою
          if (battlePoints < worstBattlePoints) {
            worstBattle = battle;
            worstBattlePoints = battlePoints;
          }
          
          // Перевіряємо, чи очки більші за поточного найкращого бою
          if (battlePoints > bestBattlePoints) {
            bestBattle = battle;
            bestBattlePoints = battlePoints;
          }
        } catch (error) {
          console.error('Помилка при обчисленні даних бою:', error, battle);
        }
      });

      return { 
        bestBattle: { battle: bestBattle, points: bestBattlePoints },
        worstBattle: { battle: worstBattle, points: worstBattlePoints }
      };
    } catch (error) {
      console.error('Помилка при пошуку найгіршого/найкращого бою:', error);
      return { bestBattle: null, worstBattle: null };
    }
  }

  // Допоміжна функція для обчислення загальних очків за бій
  calculateBattlePoints(battle) {
    let battlePoints = 0;
    
    if (battle.win === 1) {
      battlePoints += GAME_POINTS.POINTS_PER_TEAM_WIN;
    }

    if (battle && battle.players) {
      Object.values(battle.players).forEach(player => {
        battlePoints += player.points || 0;
      });
    }

    return battlePoints;
  }


  calculateBattleData(arenaId = this.curentArenaId) {
    let battlePoints = 0;
    let battleDamage = 0;
    let battleKills = 0;

    try {
      if (this.BattleStats[arenaId] && this.BattleStats[arenaId].players) {
        for (const playerId in this.BattleStats[arenaId].players) {
          const player = this.BattleStats[arenaId].players[playerId];
          battlePoints += player.points || 0;
          battleDamage += player.damage || 0;
          battleKills += player.kills || 0;
        }
      }
    } catch (error) {
      console.error('Помилка при розрахунку бойових загальних очок гравця:', error);
    }

    return { battlePoints, battleDamage, battleKills };
  }

  calculatePlayerData(playerId) {
    let playerPoints = 0;
    let playerDamage = 0;
    let playerKills = 0;

    try {
      for (const arenaId in this.BattleStats) {
        if (this.BattleStats[arenaId].players && this.BattleStats[arenaId].players[playerId]) {
          const player = this.BattleStats[arenaId].players[playerId];
          playerPoints += player.points || 0;
          playerDamage += player.damage || 0;
          playerKills += player.kills || 0;
        }
      }
    } catch (error) {
      console.error('Помилка при розрахунку загальних очок гравця:', error);
    }

    return { playerPoints, playerDamage, playerKills };
  }

  calculateTeamData() {
    let teamPoints = 0;
    let teamDamage = 0;
    let teamKills = 0;
    let wins = 0;
    let battles = 0;

    try {
      for (const arenaId in this.BattleStats) {
        battles++;
        if (this.BattleStats[arenaId].win === 1) {
          teamPoints += GAME_POINTS.POINTS_PER_TEAM_WIN;
          wins++;
        }

        if (this.BattleStats[arenaId].players) {
          for (const playerId in this.BattleStats[arenaId].players) {
            const player = this.BattleStats[arenaId].players[playerId];
            teamPoints += player.points || 0;
            teamDamage += player.damage || 0;
            teamKills += player.kills || 0;
          }
        }
      }
    } catch (error) {
      console.error('Помилка при розрахунку загальних очок команди:', error);
    }

    return { teamPoints, teamDamage, teamKills, wins, battles };
  }


  getAccessKey() {
    return localStorage.getItem('accessKey');
  }

  async saveToServer(retries = 3) {
    const accessKey = this.getAccessKey();
    if (!accessKey) {
      throw new Error('Access key not found');
    }


    for (let i = 0; i < retries; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(`${atob(STATS.BATTLE)}${accessKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Player-ID': this.curentPlayerId
          },
          body: JSON.stringify({
            BattleStats: this.BattleStats,
            PlayerInfo: this.PlayersInfo,
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok && response.status !== 202) {
          throw new Error(`Server error: ${response.status}`);
        }
        
        console.log('Дані успішно збережені на сервер');
        return true;

      } catch (error) {
        console.error(`Attempt ${i + 1} failed:`, error);
        if (i === retries - 1) throw error;
        await this.sleep(750 * (i + 1));
      }
    }
    return false;
  }


  async loadFromServer() {
    try {
      const accessKey = this.getAccessKey();
      if (!accessKey) {
        throw new Error('Access key not found');
      }

      const response = await fetch(`${atob(STATS.BATTLE)}${accessKey}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Помилка при завантаженні даних: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.success) {
        if (data.BattleStats) {
          this.BattleStats = data.BattleStats;
        }
        if (data.PlayerInfo) {
          this.PlayersInfo = data.PlayerInfo;
        }
        console.log('Дані успішно завантажені з сервера');
      }
      return true;
    } catch (error) {
      console.error('Помилка при завантаженні даних із сервера:', error);
      throw error;
    }
  }


  async loadFromServerOtherPlayers() {
    try {
      const accessKey = this.getAccessKey();
      if (!accessKey) {
        throw new Error('Access key not found');
      }
  
      const response = await fetch(`${atob(STATS.BATTLE)}pid/${accessKey}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Player-ID': this.curentPlayerId
        },
      });
  
      if (!response.ok) {
        throw new Error(`Помилка при завантаженні даних: ${response.statusText}`);
      }
  
      const data = await response.json();
  
      if (data.success) {
        console.log('Немає нових даних з сервера');
        return true;
      }
  
      if (data.BattleStats) {
        console.log('Отримано нові дані з сервера');
        let dataUpdated = false;
        
        Object.entries(data.BattleStats).forEach(([battleId, newBattleData]) => {
          const existingBattle = this.BattleStats[battleId];
          
          if (existingBattle) {
            console.log('Оновлюємо існуючий бій:', battleId);
            this.BattleStats[battleId] = {
              ...existingBattle,
              startTime: newBattleData.startTime || existingBattle.startTime,
              duration: newBattleData.duration || existingBattle.duration,
              win: newBattleData.win !== undefined ? newBattleData.win : existingBattle.win,
              mapName: newBattleData.mapName || existingBattle.mapName,
              players: { ...existingBattle.players }
            };
  
            Object.entries(newBattleData.players).forEach(([playerId, newPlayerData]) => {
              const existingPlayer = existingBattle.players[playerId];
              
              if (existingPlayer) {
                console.log(`Оновлюємо дані гравця ${playerId} (${newPlayerData.name}):`);
                console.log('- Поточна шкода:', existingPlayer.damage, 'нова шкода:', newPlayerData.damage);
                console.log('- Поточні фраги:', existingPlayer.kills, 'нові фраги:', newPlayerData.kills);
                
                // Оновлюємо тільки якщо нові значення більші за існуючі
                const updatedDamage = Math.max(existingPlayer.damage || 0, newPlayerData.damage || 0);
                const updatedKills = Math.max(existingPlayer.kills || 0, newPlayerData.kills || 0);
                
                if (updatedDamage > existingPlayer.damage || updatedKills > existingPlayer.kills) {
                  dataUpdated = true;
                }
                
                this.BattleStats[battleId].players[playerId] = {
                  name: newPlayerData.name || existingPlayer.name, 
                  vehicle: newPlayerData.vehicle || existingPlayer.vehicle,
                  damage: updatedDamage,
                  kills: updatedKills,
                  points: (updatedDamage * GAME_POINTS.POINTS_PER_DAMAGE) + (updatedKills * GAME_POINTS.POINTS_PER_FRAG)
                };
              } else {
                console.log(`Додаємо нового гравця ${playerId} (${newPlayerData.name})`);
                this.BattleStats[battleId].players[playerId] = newPlayerData;
                this.PlayersInfo[playerId] = newPlayerData.name;
                dataUpdated = true;
              }
            });
          } else {
            console.log('Додаємо новий бій:', battleId);
            this.BattleStats[battleId] = newBattleData;
            
            // Додаємо нових гравців до PlayersInfo
            Object.entries(newBattleData.players).forEach(([playerId, playerData]) => {
              if (playerData.name) {
                this.PlayersInfo[playerId] = playerData.name;
              }
            });
            
            dataUpdated = true;
          }
        });
        
        if (dataUpdated) {
          console.log('Дані були оновлені, оновлюємо інтерфейс');
          this.eventsCore.emit('statsUpdated');
          this.saveState();
        }
        
        return true;
      }
  
      return false;
    } catch (error) {
      console.error('Помилка при завантаженні даних із сервера:', error);
      throw error;
    }
  }
  

  async clearServerData() {
    try {
      const accessKey = this.getAccessKey();
      const response = await fetch(`${atob(STATS.BATTLE)}clear/${accessKey}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        },
      });

      if (!response.ok) {
        throw new Error(`Помилка при очищенні даних: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.success) {
        this.BattleStats = {};
        this.PlayersInfo = {};
        this.eventsCore.emit('statsUpdated');
      }

    } catch (error) {
      console.error('Помилка при очищенні даних на сервері:', error);
      throw error;
    }
  }

  async warmupServer() {
    try {
     
      const response = await fetch(`${atob(STATS.STATUS)}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Помилка при завантаженні даних: ${response.statusText}`);
      }

      return true;
    } catch (error) {
      console.error('Помилка при завантаженні даних із сервера:', error);
      throw error;
    }
  }

  serverDataLoad() {
    try {
      this.loadFromServer().then(() => {
        this.eventsCore.emit('statsUpdated');
        this.saveState();
      });
    } catch (error) {
      console.error('Error in serverDataLoad:', error);
    }
  }

  serverDataLoadOtherPlayers() {
    try {
      this.loadFromServerOtherPlayers().then(() => {
        // Якщо були оновлення, eventsCore.emit викликається в loadFromServerOtherPlayers
        this.saveState();
      });
    } catch (error) {
      console.error('Error in serverDataLoadOtherPlayers:', error);
    }
  }

  serverDataSave() {
    try {
      this.saveToServer().then(success => {
        if (success) {
          console.log('Дані успішно збережені на сервер');
          
          // Оновлюємо дані інших гравців після успішного збереження
          setTimeout(() => {
            this.serverDataLoadOtherPlayers();
          }, 1000);
        }
      });
    } catch (error) {
      console.error('Error in serverDataSave:', error);
    }
  }

  serverData() {
    try {
      this.saveToServer().then(success => {
        if (success) {
          setTimeout(() => {
            this.loadFromServerOtherPlayers().then(() => {
              this.eventsCore.emit('statsUpdated');
              this.saveState();
            });
          }, 1000);
        }
      });
    } catch (error) {
      console.error('Error in serverData:', error);
    }
  }

  handlePlatoonStatus(isInPlatoon) {
    this.isInPlatoon = isInPlatoon;
    this.saveState();
    
    if (isInPlatoon) {
      console.log('Гравець перебуває у взводі, оновлюємо дані взводу');
      setTimeout(() => this.serverDataLoad(), 500);
      
      // Запускаємо таймер для регулярної синхронізації
      this.startSyncTimer();
    } else {
      // Зупиняємо таймер, якщо гравець вийшов із взводу
      if (this.syncInterval) {
        clearInterval(this.syncInterval);
        this.syncInterval = null;
      }
    }
  }

  handleHangarStatus(isInHangar) {
    if (!isInHangar) return;

    const playersID = this.getPlayersIds();
    this.curentPlayerId = this.sdk.data.player.id.value;

   if (this.curentPlayerId === null) return;
    if ((this.isInPlatoon && playersID.length > 3) || (!this.isInPlatoon && playersID.length >= 1)) {
      return;
    }

    this.PlayersInfo[this.curentPlayerId] = this.sdk.data.player.name.value;

    this.serverData();
  }

  handleHangarVehicle(hangareVehicleData) {
    if (!hangareVehicleData) return;
    this.curentVehicle = hangareVehicleData.localizedShortName || hangareVehicleData.localizedName || 'Unknown Vehicle';
    console.log('Оновлено інформацію про техніку:', this.curentVehicle);
  }

  handleArena(arenaData) {
    if (!arenaData) return;

    this.curentArenaId = this.sdk?.data?.battle?.arenaId?.value ?? null;

    if (this.curentArenaId == null) return;
    if (this.curentPlayerId == null) return;

    if (this.isExistsRecord()) {
      this.initializeBattleStats(this.curentArenaId, this.curentPlayerId);

      this.BattleStats[this.curentArenaId].mapName = arenaData.localizedName || 'Unknown Map';
      this.BattleStats[this.curentArenaId].players[this.curentPlayerId].vehicle = this.curentVehicle;
      this.BattleStats[this.curentArenaId].players[this.curentPlayerId].name = this.sdk.data.player.name.value;
      
      this.serverData();
      
      // Оновлюємо статус бою - він почався
      if (this.sdk.data.battle.isInBattle && this.sdk.data.battle.isInBattle.value === true) {
        this.handleBattleStatus(true);
      }
    }
  }

  handleOnAnyDamage(onDamageData) {
    if (!onDamageData || !this.curentArenaId) return;

    const playersID = this.getPlayersIds();
    let needUpdate = false;

    // Якщо шкоду наніс гравець взводу
    if (onDamageData.attacker && onDamageData.attacker.playerId && playersID.includes(onDamageData.attacker.playerId)) {
      const attackerId = onDamageData.attacker.playerId;
      const damageAmount = onDamageData.damage || 0;
      
      if (damageAmount <= 0) return;
      
      console.log(`Зафіксовано шкоду ${damageAmount} від гравця ${this.PlayersInfo[attackerId]}`);
      
      // Ініціалізуємо статистику бою для гравця, якщо потрібно
      if (!this.BattleStats[this.curentArenaId].players[attackerId]) {
        this.initializeBattleStats(this.curentArenaId, attackerId);
      }
      
      // Оновлюємо статистику гравця
      this.BattleStats[this.curentArenaId].players[attackerId].damage += damageAmount;
      this.BattleStats[this.curentArenaId].players[attackerId].points += damageAmount * GAME_POINTS.POINTS_PER_DAMAGE;
      
      needUpdate = true;
    }
    
    // Додатково перевіряємо на випадок, якщо наш гравець отримав шкоду від іншого члена взводу
    if (onDamageData.target && onDamageData.target.playerId && 
        onDamageData.attacker && onDamageData.attacker.playerId &&
        playersID.includes(onDamageData.target.playerId) && 
        playersID.includes(onDamageData.attacker.playerId)) {
      
      needUpdate = true;
    }

    if (needUpdate && this.isExistsRecord()) {
      this.saveState();
      this.eventsCore.emit('statsUpdated');
      
      const now = Date.now();
      if (now - this.lastSyncTime > this.minSyncInterval) {
        this.serverDataLoadOtherPlayers();
        this.lastSyncTime = now;
      }
    }
  }

  handlePlayerFeedback(feedback) {
    if (!feedback || !feedback.type || !this.curentArenaId) return;
    
    console.log('Отримано PlayerFeedback:', feedback.type);

    if (feedback.type === 'damage') {
      this.handlePlayerDamage(feedback.data);
    } else if (feedback.type === 'kill') {
      this.handlePlayerKill(feedback.data);
    } else if (feedback.type === 'radioAssist' || 
              feedback.type === 'trackAssist' || 
              feedback.type === 'tanking' ||
              feedback.type === 'receivedDamage' ||
              feedback.type === 'targetVisibility' ||
              feedback.type === 'detected' ||
              feedback.type === 'spotted') {
      
      // Для інших типів зворотного зв'язку перевіряємо, чи потрібно синхронізувати дані
      const playersID = this.getPlayersIds();
      
      if (playersID.length > 1 && this.isInPlatoon) {
        const now = Date.now();
        if (now - this.lastSyncTime > this.minSyncInterval) {
          console.log(`Отримано подію ${feedback.type}, завантажуємо дані інших гравців`);
          this.serverDataLoadOtherPlayers();
          this.lastSyncTime = now;
        }
      }
    }
  }

  handlePlayerDamage(damageData) {
    if (!damageData || !this.curentArenaId || !this.curentPlayerId) return;
    
    console.log('Отримано подію damage, шкода:', damageData);

    const arenaId = this.curentArenaId;
    const playerId = this.curentPlayerId;
    
    if (!this.BattleStats[arenaId].players[playerId]) {
      this.initializeBattleStats(arenaId, playerId);
    }

    const damageAmount = damageData.damage || 0;
    if (damageAmount <= 0) return;

    this.BattleStats[arenaId].players[playerId].damage += damageAmount;
    this.BattleStats[arenaId].players[playerId].points += damageAmount * GAME_POINTS.POINTS_PER_DAMAGE;

    
    if (this.isExistsRecord()) {
      this.saveState();
      this.eventsCore.emit('statsUpdated');
      
      const now = Date.now();
      if (now - this.lastSyncTime > this.minSyncInterval) {
        this.serverDataSave();
        this.lastSyncTime = now;
      }
    }
  }

  handlePlayerKill(killData) {
    if (!killData || !this.curentArenaId || !this.curentPlayerId) return;
    
    console.log('Отримано подію kill');

    const arenaId = this.curentArenaId;
    const playerId = this.curentPlayerId;
    
    if (!this.BattleStats[arenaId].players[playerId]) {
      this.initializeBattleStats(arenaId, playerId);
    }

    this.BattleStats[arenaId].players[playerId].kills += 1;
    this.BattleStats[arenaId].players[playerId].points += GAME_POINTS.POINTS_PER_FRAG;

    if (this.isExistsRecord()) {
      this.saveState();
      this.eventsCore.emit('statsUpdated');
      
      const now = Date.now();
      if (now - this.lastSyncTime > this.minSyncInterval) {
        this.serverDataSave();
        this.lastSyncTime = now;
      }
    }
  }

  handleBattleResult(result) {
    if (!result || !result.vehicles || !result.players) {
      console.error("Invalid battle result data");
      return;
    }
    
    const arenaId = result.arenaUniqueID;
    if (!arenaId) return;

    console.log('Отримано результат бою:', result);

    this.curentPlayerId = result.personal.avatar.accountDBID;
    
    // Перевіряємо, чи бій вже існує в статистиці
    if (!this.BattleStats[arenaId]) {
      this.initializeBattleStats(arenaId, this.curentPlayerId);
    }
    
    this.BattleStats[arenaId].duration = result.common.duration;

    const playerTeam = Number(result.players[this.curentPlayerId].team);
    const winnerTeam = Number(result.common.winnerTeam);


    if (playerTeam !== undefined && playerTeam !== 0 && winnerTeam !== undefined) {
      if (playerTeam === winnerTeam) {
        this.BattleStats[arenaId].win = 1;
      } else if (winnerTeam === 0) {
        this.BattleStats[arenaId].win = 2;
      } else {
        this.BattleStats[arenaId].win = 0;
      }
    }

    // Оновлюємо статистику всіх гравців взводу
    const playersIds = this.getPlayersIds();
    playersIds.forEach(playerId => {
      if (!this.BattleStats[arenaId].players[playerId]) {
        this.initializeBattleStats(arenaId, playerId);
      }
      
      // Шукаємо дані гравця в результатах
      let playerFound = false;
      
      // Перевіряємо дані в vehicles
      for (const vehicleId in result.vehicles) {
        const vehicles = result.vehicles[vehicleId];
        
        if (Array.isArray(vehicles)) {
          for (const vehicle of vehicles) {
            if ((vehicle.accountDBID && vehicle.accountDBID == playerId) || 
                (vehicle.playerID && vehicle.playerID == playerId) ||
                (vehicle.dbid && vehicle.dbid == playerId)) {
              
              // Оновлюємо статистику
              this.BattleStats[arenaId].players[playerId].damage = vehicle.damageDealt || 0;
              this.BattleStats[arenaId].players[playerId].kills = vehicle.kills || 0;
              this.BattleStats[arenaId].players[playerId].points = 
                (vehicle.damageDealt || 0) + ((vehicle.kills || 0) * GAME_POINTS.POINTS_PER_FRAG);
              
              playerFound = true;
              break;
            }
          }
        } else if (typeof vehicles === 'object' && vehicles !== null) {
          if ((vehicles.accountDBID && vehicles.accountDBID == playerId) || 
              (vehicles.playerID && vehicles.playerID == playerId) ||
              (vehicles.dbid && vehicles.dbid == playerId)) {
            
            // Оновлюємо статистику
            this.BattleStats[arenaId].players[playerId].damage = vehicles.damageDealt || 0;
            this.BattleStats[arenaId].players[playerId].kills = vehicles.kills || 0;
            this.BattleStats[arenaId].players[playerId].points = 
              (vehicles.damageDealt || 0) + ((vehicles.kills || 0) * GAME_POINTS.POINTS_PER_FRAG);
            
            playerFound = true;
          }
        }
        
        if (playerFound) break;
      }
      
      // Якщо гравця не знайдено в vehicles, шукаємо в players
      if (!playerFound && result.players[playerId]) {
        const playerResult = result.players[playerId];
        
        // Шукаємо дані про шкоду і фраги
        let playerDamage = 0;
        let playerKills = 0;
        
        if (playerResult.damageDealt) playerDamage = playerResult.damageDealt;
        if (playerResult.damage) playerDamage = playerResult.damage;
        if (playerResult.kills) playerKills = playerResult.kills;
        if (playerResult.frags) playerKills = playerResult.frags;
        
        // Оновлюємо тільки якщо знайдені нові дані
        if (playerDamage > 0 || playerKills > 0) {
          this.BattleStats[arenaId].players[playerId].damage = playerDamage;
          this.BattleStats[arenaId].players[playerId].kills = playerKills;
          this.BattleStats[arenaId].players[playerId].points = 
            playerDamage + (playerKills * GAME_POINTS.POINTS_PER_FRAG);
        }
      }
    });
    
    this.warmupServer();
    this.saveState();
    this.eventsCore.emit('statsUpdated');
    
    // Гарантована синхронізація в кінці бою
    setTimeout(() => {
      if (this.isExistsRecord()) {
        this.serverData();
      }
    }, 1000);
  }

  // Зупиняємо інтервал синхронізації при знищенні об'єкта
  cleanup() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }
}

export default CoreService;

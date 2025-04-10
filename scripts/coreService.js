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

    // Налаштування для синхронізації
    this.syncInterval = null;
    this.lastSyncTime = 0;
    this.minSyncInterval = 15000; // 15 секунд мінімальний час між синхронізаціями

    // Для відстеження уже облікованої шкоди та фрагів
    this.processedEvents = {
      damage: {},
      kills: {}
    };

    this.setupSDKListeners();
    this.eventsCore = new EventEmitter();
    this.loadFromServer();
    this.startSyncTimer(); // Запускаємо таймер регулярної синхронізації
  }

  // Запуск регулярної синхронізації
  startSyncTimer() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    
    // Запускаємо синхронізацію кожні 30 секунд
    this.syncInterval = setInterval(() => {
      console.log('Регулярна синхронізація');
      
      if (this.isExistsRecord()) {
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

  setupSDKListeners() {
    this.sdk.data.hangar.isInHangar.watch(this.handleHangarStatus.bind(this));
    this.sdk.data.hangar.vehicle.info.watch(this.handleHangarVehicle.bind(this));
    this.sdk.data.platoon.isInPlatoon.watch(this.handlePlatoonStatus.bind(this));
    this.sdk.data.battle.arena.watch(this.handleArena.bind(this));
    this.sdk.data.battle.isInBattle.watch(this.handleBattleStatus.bind(this));
    
    // Основні джерела шкоди
    this.sdk.data.battle.onDamage.watch(this.handleOnAnyDamage.bind(this));
    this.sdk.data.battle.personal.damageDealt.watch(this.handlePersonalDamage.bind(this));
    
    // Інші події
    this.sdk.data.battle.onPlayerFeedback.watch(this.handlePlayerFeedback.bind(this));
    this.sdk.data.battle.onBattleResult.watch(this.handleBattleResult.bind(this));
    this.sdk.data.battle.onKilled.watch(this.handleOnKilled.bind(this));
  }

  // Обробка стану бою
  handleBattleStatus(isInBattle) {
    if (isInBattle && this.isInPlatoon) {
      // Якщо гравець увійшов у бій і перебуває у взводі, запускаємо частішу синхронізацію
      if (this.syncInterval) {
        clearInterval(this.syncInterval);
      }
      
      this.syncInterval = setInterval(() => {
        console.log('Синхронізація в бою');
        
        if (this.isExistsRecord()) {
          const now = Date.now();
          if (now - this.lastSyncTime > this.minSyncInterval) {
            this.serverDataLoadOtherPlayers();
            this.lastSyncTime = now;
          }
        }
      }, 15000); // У бою синхронізуємося частіше - кожні 15 секунд
      
      // Скидаємо відстеження подій для нового бою
      this.clearEventTracking();
    } else if (!isInBattle) {
      // Повертаємося до звичайного режиму синхронізації
      this.startSyncTimer();
    }
  }

  // Скидання відстеження подій
  clearEventTracking() {
    this.processedEvents = {
      damage: {},
      kills: {}
    };
  }

  // Перевірка, чи була вже оброблена ця подія шкоди
  isDamageProcessed(playerId, amount, time) {
    if (!this.processedEvents.damage[playerId]) {
      this.processedEvents.damage[playerId] = [];
      return false;
    }

    // Перевіряємо, чи була схожа подія за останні 3 секунди
    const similarEvent = this.processedEvents.damage[playerId].find(event => {
      return Math.abs(event.amount - amount) < 10 && (time - event.time) < 3000;
    });

    return !!similarEvent;
  }

  // Додаємо подію шкоди до відстежених
  addProcessedDamage(playerId, amount) {
    if (!this.processedEvents.damage[playerId]) {
      this.processedEvents.damage[playerId] = [];
    }

    this.processedEvents.damage[playerId].push({
      amount: amount,
      time: Date.now()
    });

    // Обмежуємо розмір масиву, щоб уникнути перевитрати пам'яті
    if (this.processedEvents.damage[playerId].length > 20) {
      this.processedEvents.damage[playerId] = this.processedEvents.damage[playerId].slice(-20);
    }
  }

  // Перевірка, чи було вже оброблено вбивство
  isKillProcessed(playerId, victimId, time) {
    const killId = `${playerId}-${victimId}`;
    
    if (!this.processedEvents.kills[killId]) {
      this.processedEvents.kills[killId] = [];
      return false;
    }

    // Перевіряємо, чи було схоже вбивство за останні 5 секунд
    const similarEvent = this.processedEvents.kills[killId].find(event => {
      return (time - event) < 5000;
    });

    return !!similarEvent;
  }

  // Додаємо вбивство до відстежених
  addProcessedKill(playerId, victimId) {
    const killId = `${playerId}-${victimId}`;
    
    if (!this.processedEvents.kills[killId]) {
      this.processedEvents.kills[killId] = [];
    }

    this.processedEvents.kills[killId].push(Date.now());

    // Обмежуємо розмір масиву
    if (this.processedEvents.kills[killId].length > 5) {
      this.processedEvents.kills[killId] = this.processedEvents.kills[killId].slice(-5);
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
                // Оновлюємо тільки якщо нові значення більші за існуючі
                let updated = false;
                
                if ((newPlayerData.damage || 0) > (existingPlayer.damage || 0)) {
                  this.BattleStats[battleId].players[playerId].damage = newPlayerData.damage;
                  updated = true;
                  console.log(`Оновлено шкоду гравця ${playerId} до ${newPlayerData.damage}`);
                }
                
                if ((newPlayerData.kills || 0) > (existingPlayer.kills || 0)) {
                  this.BattleStats[battleId].players[playerId].kills = newPlayerData.kills;
                  updated = true;
                  console.log(`Оновлено фраги гравця ${playerId} до ${newPlayerData.kills}`);
                }
                
                if (updated) {
                  // Перераховуємо очки
                  this.BattleStats[battleId].players[playerId].points = 
                    (this.BattleStats[battleId].players[playerId].damage * GAME_POINTS.POINTS_PER_DAMAGE) + 
                    (this.BattleStats[battleId].players[playerId].kills * GAME_POINTS.POINTS_PER_FRAG);
                  
                  dataUpdated = true;
                }
                
                // Оновлюємо ім'я та техніку в будь-якому випадку
                this.BattleStats[battleId].players[playerId].name = newPlayerData.name || existingPlayer.name;
                this.BattleStats[battleId].players[playerId].vehicle = newPlayerData.vehicle || existingPlayer.vehicle;
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
    console.log('Статус взводу змінено:', isInPlatoon);
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
      
      // Очищаємо відстеження подій для нового бою
      this.clearEventTracking();
      
      // Зберігаємо дані та завантажуємо інформацію про інших гравців
      this.serverData();
    }
  }

  // Обробка personal.damageDealt як надійного джерела шкоди для поточного гравця
  handlePersonalDamage(newValue, oldValue) {
    if (!this.curentArenaId || !this.curentPlayerId) return;
    
    // Пропускаємо, якщо значення не змінилося або не число
    if (newValue === oldValue || typeof newValue !== 'number' || newValue <= 0) return;
    
    // Ініціалізуємо гравця, якщо потрібно
    if (!this.BattleStats[this.curentArenaId].players[this.curentPlayerId]) {
      this.initializeBattleStats(this.curentArenaId, this.curentPlayerId);
    }
    
    const currentPlayer = this.BattleStats[this.curentArenaId].players[this.curentPlayerId];
    
    // Оновлюємо шкоду тільки якщо нове значення більше
    if (newValue > currentPlayer.damage) {
      console.log(`Оновлюємо шкоду поточного гравця з ${currentPlayer.damage} до ${newValue}`);
      
      currentPlayer.damage = newValue;
      currentPlayer.points = (newValue * GAME_POINTS.POINTS_PER_DAMAGE) + (currentPlayer.kills * GAME_POINTS.POINTS_PER_FRAG);
      
      // Зберігаємо оновлені дані та сповіщаємо про зміни
      this.saveState();
      this.eventsCore.emit('statsUpdated');
      
      // Синхронізуємо з сервером, якщо пройшов мінімальний інтервал
      const now = Date.now();
      if (now - this.lastSyncTime > this.minSyncInterval) {
        this.serverDataSave();
        this.lastSyncTime = now;
      }
    }
  }

  // Обробка onDamage для отримання шкоди від взводних гравців
  handleOnAnyDamage(onDamageData) {
    if (!onDamageData || !this.curentArenaId) return;

    // Перевіряємо, чи є дані про нападника
    if (!onDamageData.attacker || !onDamageData.attacker.playerId) return;
    
    const attackerId = onDamageData.attacker.playerId;
    const damageAmount = onDamageData.damage || 0;
    
    // Пропускаємо нульову шкоду
    if (damageAmount <= 0) return;
    
    // Отримуємо список гравців взводу
    const platoonPlayers = this.getPlayersIds();
    
    // Перевіряємо, чи є нападник гравцем взводу і не є поточним гравцем
    if (platoonPlayers.includes(attackerId) && attackerId !== this.curentPlayerId) {
      const currentTime = Date.now();
      
      // Перевіряємо, чи була ця шкода вже оброблена
      if (this.isDamageProcessed(attackerId, damageAmount, currentTime)) {
        console.log(`Шкода ${damageAmount} від ${this.PlayersInfo[attackerId]} вже була оброблена`);
        return;
      }
      
      console.log(`Обробка шкоди ${damageAmount} від гравця взводу ${this.PlayersInfo[attackerId]}`);
      
      // Додаємо подію до відстежених
      this.addProcessedDamage(attackerId, damageAmount);
      
      // Ініціалізуємо гравця, якщо потрібно
      if (!this.BattleStats[this.curentArenaId].players[attackerId]) {
        this.initializeBattleStats(this.curentArenaId, attackerId);
      }
      
      // Оновлюємо шкоду та очки
      this.BattleStats[this.curentArenaId].players[attackerId].damage += damageAmount;
      this.BattleStats[this.curentArenaId].players[attackerId].points = 
        (this.BattleStats[this.curentArenaId].players[attackerId].damage * GAME_POINTS.POINTS_PER_DAMAGE) +
        (this.BattleStats[this.curentArenaId].players[attackerId].kills * GAME_POINTS.POINTS_PER_FRAG);
      
      // Зберігаємо дані та оновлюємо інтерфейс
      this.saveState();
      this.eventsCore.emit('statsUpdated');
      
      // Відправляємо дані на сервер, якщо пройшов мінімальний інтервал
      const now = Date.now();
      if (now - this.lastSyncTime > this.minSyncInterval) {
        this.serverDataSave();
        this.lastSyncTime = now;
      }
    }
  }

  // Обробка події вбивства
  handleOnKilled(data) {
    if (!this.curentArenaId || !data || !data.attacker || !data.attacker.playerId) return;
    
    const attackerId = data.attacker.playerId;
    const platoonPlayers = this.getPlayersIds();
    
    // Перевіряємо, чи є нападник гравцем взводу
    if (platoonPlayers.includes(attackerId)) {
      const victimId = data.victim ? (data.victim.id || data.victim.playerId || "unknown") : "unknown";
      const currentTime = Date.now();
      
      // Перевіряємо, чи було це вбивство вже оброблено
      if (this.isKillProcessed(attackerId, victimId, currentTime)) {
        console.log(`Фраг ${this.PlayersInfo[attackerId]} проти ${victimId} вже було оброблено`);
        return;
      }
      
      console.log(`Обробка фрагу від гравця взводу ${this.PlayersInfo[attackerId]}`);
      
      // Додаємо вбивство до відстежених
      this.addProcessedKill(attackerId, victimId);
      
      // Ініціалізуємо гравця, якщо потрібно
      if (!this.BattleStats[this.curentArenaId].players[attackerId]) {
        this.initializeBattleStats(this.curentArenaId, attackerId);
      }
      
      // Оновлюємо кількість фрагів та очки
      this.BattleStats[this.curentArenaId].players[attackerId].kills += 1;
      this.BattleStats[this.curentArenaId].players[attackerId].points = 
        (this.BattleStats[this.curentArenaId].players[attackerId].damage * GAME_POINTS.POINTS_PER_DAMAGE) +
        (this.BattleStats[this.curentArenaId].players[attackerId].kills * GAME_POINTS.POINTS_PER_FRAG);
      
      // Зберігаємо дані та оновлюємо інтерфейс
      this.saveState();
      this.eventsCore.emit('statsUpdated');
      
      // Відправляємо дані на сервер, якщо пройшов мінімальний інтервал
      const now = Date.now();
      if (now - this.lastSyncTime > this.minSyncInterval) {
        this.serverDataSave();
        this.lastSyncTime = now;
      }
    }
  }

  // Обробка різних подій зворотного зв'язку
  handlePlayerFeedback(feedback) {
    if (!feedback || !feedback.type || !this.curentArenaId || !this.curentPlayerId) return;
    
    // Основні події - шкода та фраги - вже обробляються окремо
    // Тут тільки відстежуємо допоміжні події для синхронізації

    // Регулярно оновлюємо дані з сервера при деяких типах подій
    const triggerSyncEvents = ['radioAssist', 'trackAssist', 'tanking', 'targetVisibility', 'spotted'];
    
    if (triggerSyncEvents.includes(feedback.type)) {
      const now = Date.now();
      if (now - this.lastSyncTime > this.minSyncInterval && this.isInPlatoon) {
        console.log(`Отримано подію ${feedback.type}, синхронізуємо дані`);
        this.serverDataLoadOtherPlayers();
        this.lastSyncTime = now;
      }
    }
  }

  // Обробка результатів бою - найбільш надійне джерело даних
  handleBattleResult(result) {
    if (!result || !result.vehicles || !result.players) {
      console.error("Invalid battle result data");
      return;
    }
    
    const arenaId = result.arenaUniqueID;
    if (!arenaId) return;

    console.log('Отримано результат бою:', result);

    this.curentPlayerId = result.personal.avatar.accountDBID;
    
    // Скидаємо відстеження подій для завершеного бою
    this.clearEventTracking();
    
    // Перевіряємо, чи бій вже існує в статистиці
    if (!this.BattleStats[arenaId]) {
      this.initializeBattleStats(arenaId, this.curentPlayerId);
    }
    
    this.BattleStats[arenaId].duration = result.common.duration;

    // Визначаємо результат бою
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

    // Оновлюємо статистику всіх гравців взводу на основі результатів бою
    const playersIds = this.getPlayersIds();
    playersIds.forEach(playerId => {
      if (!this.BattleStats[arenaId].players[playerId]) {
        this.initializeBattleStats(arenaId, playerId);
      }
      
      // Шукаємо дані гравця в результатах бою
      let foundPlayerData = null;
      
      // Шукаємо в vehicles
      for (const vehicleId in result.vehicles) {
        const vehicles = result.vehicles[vehicleId];
        
        if (Array.isArray(vehicles)) {
          for (const vehicle of vehicles) {
            if ((vehicle.accountDBID && vehicle.accountDBID == playerId) || 
                (vehicle.playerID && vehicle.playerID == playerId) ||
                (vehicle.dbid && vehicle.dbid == playerId)) {
              
              foundPlayerData = {
                damage: vehicle.damageDealt || 0,
                kills: vehicle.kills || 0
              };
              break;
            }
          }
        } else if (typeof vehicles === 'object' && vehicles !== null) {
          if ((vehicles.accountDBID && vehicles.accountDBID == playerId) || 
              (vehicles.playerID && vehicles.playerID == playerId) ||
              (vehicles.dbid && vehicles.dbid == playerId)) {
            
            foundPlayerData = {
              damage: vehicles.damageDealt || 0,
              kills: vehicles.kills || 0
            };
          }
        }
        
        if (foundPlayerData) break;
      }
      
      // Якщо не знайдено в vehicles, шукаємо в players
      if (!foundPlayerData && result.players[playerId]) {
        const playerResult = result.players[playerId];
        
        foundPlayerData = {
          damage: playerResult.damageDealt || playerResult.damage || 0,
          kills: playerResult.kills || playerResult.frags || 0
        };
      }
      
      // Якщо знайдені дані, оновлюємо статистику гравця
      if (foundPlayerData) {
        console.log(`Оновлюємо дані гравця ${playerId} на основі результатів бою:`, foundPlayerData);
        
        // Замінюємо дані гравця тими, що з результатів бою
        this.BattleStats[arenaId].players[playerId].damage = foundPlayerData.damage;
        this.BattleStats[arenaId].players[playerId].kills = foundPlayerData.kills;
        this.BattleStats[arenaId].players[playerId].points = 
          (foundPlayerData.damage * GAME_POINTS.POINTS_PER_DAMAGE) + 
          (foundPlayerData.kills * GAME_POINTS.POINTS_PER_FRAG);
      }
    });
    
    // Розігріваємо сервер і зберігаємо дані
    this.warmupServer();
    this.saveState();
    this.eventsCore.emit('statsUpdated');
    
    // Гарантована синхронізація даних після закінчення бою
    setTimeout(() => {
      if (this.isExistsRecord()) {
        this.serverData();
      }
    }, 1000);
  }

  // Зупиняємо синхронізацію при знищенні об'єкта
  cleanup() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }
}

export default CoreService;

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

    this.reconnectAttempts = 0;
    this.baseDelay = 5000;   
    this.maxDelay = 20000;     

    this.setupSDKListeners();
    this.eventsCore = new EventEmitter();
    this.setupWebSocket();
    this.loadFromServer();
    this.startWebSocketMonitoring();
  }

  startWebSocketMonitoring() {
    setInterval(() => {
        if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            const delay = Math.min(
                this.baseDelay * Math.pow(2, this.reconnectAttempts),
                this.maxDelay
            );
            
            setTimeout(() => {
                this.setupWebSocket();
                this.reconnectAttempts++;
            }, delay);
        } else {
            this.reconnectAttempts = 0;
        }
    }, 10000);
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

  setupWebSocket() {
    const accessKey = this.getAccessKey();
    if (!accessKey || !this.curentPlayerId) return;

    const baseUrl = atob(STATS.WS);
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${baseUrl}?playerId=${this.curentPlayerId}`;

    if (this.ws) {
        this.ws.close();
    }

    this.ws = new WebSocket(wsUrl);
    
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
        this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
        try {
            if (event.data instanceof ArrayBuffer) {
                const view = new Uint8Array(event.data);
                const success = view[0] === 1;
                
                if (success) {
                    console.log('Дані успішно збережені');
                } else {
                    console.log('Помилка при збереженні даних');
                }
            }
        } catch (error) {
            console.error('Помилка обробки WebSocket повідомлення:', error);
        }
    };

    this.ws.onerror = (error) => {
        console.error('WebSocket помилка:', error);
    };

    this.ws.onclose = () => {
        // console.log('WebSocket з'єднання закрито');
    };
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
    this.sdk.data.battle.onDamage.watch(this.handleOnAnyDamage.bind(this));
    this.sdk.data.battle.onPlayerFeedback.watch(this.handlePlayerFeedback.bind(this));
    this.sdk.data.battle.onBattleResult.watch(this.handleBattleResult.bind(this));
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
    if (this.ws) {
      this.ws.close();
    }

    this.BattleStats = {};
    this.PlayersInfo = {};
    this.curentPlayerId = this.sdk.data.player.id.value;
    this.curentArenaId = null;
    this.curentVehicle = null;
    this.isInPlatoon = false;

    this.setupWebSocket();
  }

  initializeBattleStats(arenaId, playerId) {
    console.log("Ініціалізуємо дані бою:", { arenaId, playerId });
    
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
    
    console.log("Дані бою після ініціалізації:", this.BattleStats[arenaId]);
  }

  getPlayer(id) {
    return this.PlayersInfo[id] || null;
  }

  getPlayersIds() {
    return Object.keys(this.PlayersInfo || {})
      .filter(key => !isNaN(key))
      .map(Number);
  }

  calculatePlayerData(playerId) {
    let playerPoints = 0;
    let playerDamage = 0;
    let playerKills = 0;

    try {
      for (const arenaId in this.BattleStats) {
        const player = this.BattleStats[arenaId].players[playerId];
        if (player) {
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

        for (const playerId in this.BattleStats[arenaId].players) {
          const player = this.BattleStats[arenaId].players[playerId];
          teamPoints += player.points || 0;
          teamDamage += player.damage || 0;
          teamKills += player.kills || 0;
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
        

        return true;

      } catch (error) {
        console.error(`Attempt ${i + 1} failed:`, error);
        if (i === retries - 1) throw error;
        this.sleep(750 * (i + 1));
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
        return true;
      }
  
      if (data.BattleStats) {
        // Зберігаємо поточні дані бою
        const currentBattleData = this.curentArenaId && this.BattleStats[this.curentArenaId] 
          ? JSON.parse(JSON.stringify(this.BattleStats[this.curentArenaId])) 
          : null;
          
        Object.entries(data.BattleStats).forEach(([battleId, newBattleData]) => {
          const existingBattle = this.BattleStats[battleId];
  
          if (existingBattle) {
            this.BattleStats[battleId] = {
              ...existingBattle,
              startTime: newBattleData.startTime,
              duration: newBattleData.duration,
              win: newBattleData.win,
              mapName: newBattleData.mapName,
              players: { ...existingBattle.players }
            };
  
            Object.entries(newBattleData.players).forEach(([playerId, newPlayerData]) => {
              const existingPlayer = existingBattle.players[playerId];
  
              if (existingPlayer) {
                this.BattleStats[battleId].players[playerId] = {
                  name: newPlayerData.name, 
                  vehicle: newPlayerData.vehicle,
                  damage: Math.max(existingPlayer.damage || 0, newPlayerData.damage || 0),
                  kills: Math.max(existingPlayer.kills || 0, newPlayerData.kills || 0),
                  points: Math.max(existingPlayer.points || 0, newPlayerData.points || 0)
                };
              } else {
                this.BattleStats[battleId].players[playerId] = newPlayerData;
              }
            });
          } else {
            this.BattleStats[battleId] = newBattleData;
          }
        });

        // Відновлюємо поточні дані бою
        if (currentBattleData && this.curentArenaId) {
          this.BattleStats[this.curentArenaId] = currentBattleData;
          console.log("Відновлено поточні дані бою:", this.BattleStats[this.curentArenaId]);
        }

        if (data.PlayerInfo) {
          Object.entries(data.PlayerInfo).forEach(([playerId, playerName]) => {
            this.PlayersInfo[playerId] = playerName;
          });
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
      this.loadFromServer();
      this.eventsCore.emit('statsUpdated');
      this.sleep(50);
      this.saveState();

    } catch (error) {
      console.error('Error in serverDataLoad:', error);
    }
  }

  serverDataLoadOtherPlayers() {
    try {
      this.loadFromServerOtherPlayers();
      this.sleep(50);
      this.eventsCore.emit('statsUpdated');
      this.saveState();

    } catch (error) {
      console.error('Error in serverDataLoad:', error);
    }
  }

  serverDataSave() {
    try {
      this.saveToServer();
    } catch (error) {
      console.error('Error in serverDataSave:', error);
    }
  }

  serverData() {
    try {
      // Зберігаємо поточні дані бою
      const currentBattleData = this.curentArenaId && this.BattleStats[this.curentArenaId] 
        ? JSON.parse(JSON.stringify(this.BattleStats[this.curentArenaId])) 
        : null;
      
      // Зберігаємо дані на сервер і завантажуємо дані інших гравців
      this.saveToServer();
      this.sleep(250);
      this.loadFromServerOtherPlayers();
      
      // Відновлюємо поточні дані бою
      if (currentBattleData && this.curentArenaId) {
        this.BattleStats[this.curentArenaId] = currentBattleData;
      }
      
      this.sleep(50);
      this.eventsCore.emit('statsUpdated');
      this.saveState();
    } catch (error) {
      console.error('Error in serverData:', error);
    }
  }

  handlePlatoonStatus(isInPlatoon) {
    this.isInPlatoon = isInPlatoon;
    this.saveState();
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
    this.curentVehicle = hangareVehicleData.localizedShortName || 'Unknown Vehicle';
  }

  handleArena(arenaData) {
    if (!arenaData) return;

    this.curentArenaId = this.sdk?.data?.battle?.arenaId?.value ?? null;
    console.log("Встановлено поточну арену:", this.curentArenaId);

    if (this.curentArenaId == null) return;
    if (this.curentPlayerId == null) return;

    this.initializeBattleStats(this.curentArenaId, this.curentPlayerId);

    this.BattleStats[this.curentArenaId].mapName = arenaData.localizedName || 'Unknown Map';
    this.BattleStats[this.curentArenaId].players[this.curentPlayerId].vehicle = this.curentVehicle;
    this.BattleStats[this.curentArenaId].players[this.curentPlayerId].name = this.sdk.data.player.name.value;

    this.serverData();
  }

  handleOnAnyDamage(onDamageData) {
    if (!onDamageData || !this.curentArenaId || !this.sdk.data.player.id.value) return;

    console.log("Отримано дані про пошкодження:", onDamageData);
    const playersID = this.getPlayersIds();

    for (const playerId of playersID) {
      if (onDamageData.attacker.playerId === parseInt(playerId) && parseInt(playerId) !== this.sdk.data.player.id.value) {
        this.serverDataLoadOtherPlayers();
        break;
      }
    }
  }


  handlePlayerFeedback(feedback) {
    if (!feedback || !feedback.type) return;

    console.log("Отримано зворотній зв'язок гравця:", feedback);

    if (feedback.type === 'damage') {
      this.handlePlayerDamage(feedback.data);
    } else if (feedback.type === 'kill') {
      this.handlePlayerKill(feedback.data);
    } else if (feedback.type === 'radioAssist') {
      this.handlePlayerRadioAssist(feedback.data);
    } else if (feedback.type === 'trackAssist') {
      this.handlePlayerTrackAssist(feedback.data);
    } else if (feedback.type === 'tanking') {
      this.handlePlayerTanking(feedback.data);
    } else if (feedback.type === 'receivedDamage') {
      this.handlePlayerReceivedDamage(feedback.data);
    }
  }


  handlePlayerDamage(damageData) {
    if (!damageData || !this.curentArenaId || !this.curentPlayerId) return;

    const arenaId = this.curentArenaId;
    const playerId = this.curentPlayerId;

    console.log("Оброблюємо шкоду гравця:", { 
      arenaId, 
      playerId, 
      damage: damageData.damage, 
      points: damageData.damage * GAME_POINTS.POINTS_PER_DAMAGE 
    });

    // Ініціалізуємо дані гравця, якщо вони ще не ініціалізовані
    this.initializeBattleStats(arenaId, playerId);

    // Оновлюємо статистику
    this.BattleStats[arenaId].players[playerId].damage += damageData.damage;
    this.BattleStats[arenaId].players[playerId].points += damageData.damage * GAME_POINTS.POINTS_PER_DAMAGE;

    // Спочатку оновлюємо UI
    this.eventsCore.emit('statsUpdated');
    
    // Потім синхронізуємо з сервером
    this.serverData();
  }

  handlePlayerKill(killData) {
    if (!killData || !this.curentArenaId || !this.curentPlayerId) return;

    const arenaId = this.curentArenaId;
    const playerId = this.curentPlayerId;

    console.log("Оброблюємо вбивство гравця:", { 
      arenaId, 
      playerId, 
      points: GAME_POINTS.POINTS_PER_FRAG 
    });

    // Ініціалізуємо дані гравця, якщо вони ще не ініціалізовані
    this.initializeBattleStats(arenaId, playerId);

    // Оновлюємо статистику
    this.BattleStats[arenaId].players[playerId].kills += 1;
    this.BattleStats[arenaId].players[playerId].points += GAME_POINTS.POINTS_PER_FRAG;

    // Спочатку оновлюємо UI
    this.eventsCore.emit('statsUpdated');
    
    // Потім синхронізуємо з сервером
    this.serverData();
  }

  handlePlayerRadioAssist(radioAssist) {
    if (!radioAssist || !this.curentArenaId || !this.curentPlayerId) return;
    this.serverDataLoadOtherPlayers();
  }

  handlePlayerTrackAssist(trackAssist) {
    if (!trackAssist || !this.curentArenaId || !this.curentPlayerId) return;
    this.serverDataLoadOtherPlayers();
  }

  handlePlayerTanking(tanking) {
    if (!tanking || !this.curentArenaId || !this.curentPlayerId) return;
    this.serverDataLoadOtherPlayers();
  }

  handlePlayerReceivedDamage(receivedDamage) {
    if (!receivedDamage || !this.curentArenaId || !this.curentPlayerId) return;
    this.serverDataLoadOtherPlayers();
  }

  handleBattleResult(result) {
    if (!result || !result.vehicles || !result.players) {
      console.error("Invalid battle result data");
      return;
    }
    
    const arenaId = result.arenaUniqueID;
    if (!arenaId) return;

    console.log("Отримано результат бою:", { arenaId });

    this.curentPlayerId = result.personal.avatar.accountDBID;
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

    for (const vehicleId in result.vehicles) {
      const vehicles = result.vehicles[vehicleId];
      for (const vehicle of vehicles) {
        if (vehicle.accountDBID === this.curentPlayerId) {
          const playerStats = this.BattleStats[arenaId].players[this.curentPlayerId];
          playerStats.damage = vehicle.damageDealt;
          playerStats.kills = vehicle.kills;
          playerStats.points = vehicle.damageDealt + (vehicle.kills * GAME_POINTS.POINTS_PER_FRAG);
          break;
        }
      }
    }
    
    this.warmupServer();
    
    // Зберігаємо стан локально
    this.saveState();
    
    // Оновлюємо UI перед відправкою на сервер
    this.eventsCore.emit('statsUpdated');
    
    // Потім синхронізуємо з сервером
    this.serverData();
  }

  cleanup() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

export default CoreService;

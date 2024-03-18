const getWaterLevelFromDatabase = async (villageName, dayKey, timeKey) => {
    try {
      const userRef = ref(database, `users/${villageName}/${dayKey}/${timeKey}`);
      const snapshot = await get(userRef);
  
      if (snapshot.exists()) {
        const waterLevel = snapshot.val();
        console.log(`${villageName}/${dayKey}/${timeKey}:`, waterLevel, "Value retrieved from the database");
        return waterLevel;
      } else {
        console.log(`${villageName}/${dayKey}/${timeKey}: No data found in the database`);
        return null;
      }
    } catch (error) {
      console.error("Error retrieving value from the database:", error);
      throw error;
    }
  };
  
  // Example usage:
  const villageName = "yourVillageName"; // Replace with the actual village name
  const dayKey = "day1"; // Replace with the actual day key
  const timeKey = "12:30"; // Replace with the actual time key
  
  getWaterLevelFromDatabase(villageName, dayKey, timeKey)
    .then((waterLevel) => {
      // Do something with the retrieved water level
      console.log("Retrieved water level:", waterLevel);
    })
    .catch((error) => {
      // Handle errors
      console.error("Error:", error);
    });
  
import React, { useState, createContext } from "react";

export const UserContext = createContext();

const UserProvider = ({ children }) => {
  const [users, setUsers] = useState(null);
  const [selectedAssistant, setSelectedAssistant] = useState(null);

  const getGeminiResponse = async () => {
    return null;
  };

  return (
    <UserContext.Provider
      value={{
        users,
        setUsers,
        selectedAssistant,
        setSelectedAssistant,
        getGeminiResponse,
      }}
    >
      {children}
    </UserContext.Provider>
  );
};

export default UserProvider;

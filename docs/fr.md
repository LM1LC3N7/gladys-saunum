# Saunum pour Gladys

Cette intégration affiche un **sauna Saunum Leil** dans Gladys, par le Modbus
TCP de son panneau de commande sur votre réseau local. **Jamais testé avec un
vrai appareil.** Sans lien avec Saunum.

> **Sécurité.** Un sauna chauffe très fort. Ne lancez jamais la chauffe à
> distance sans vous assurer que personne n’est dedans et que rien ne repose
> sur le poêle. L’allumage depuis Gladys est **désactivé par défaut** et
> refusé porte ouverte ; l’extinction n’est jamais retenue par l’intégration.

## Ce que vous obtenez

Un sauna dans l’onglet Découverte, avec :

- **Séance en cours** (oui/non, lecture seule) et l’**état** en texte (« En
  veille », « Programmé », « En chauffe », « Prêt », « Refroidissement », « En
  attente de la porte », avec « , alarme » quand une alarme est active) ;
- **température** mesurée, **humidité** (micrologiciel récent seulement),
  **porte** (capteur d’ouverture), **résistances en marche**, **alarme**
  (oui/non) ;
- la **consigne** (thermostat) et le **temps de séance restant** (minutes,
  micrologiciel récent seulement) ;
- la **lumière** (marche/arrêt) ;
- deux boutons : **Allumer (chauffer)** et **Éteindre**.

Pas d’interrupteur pour la séance : un « tout allumer » de Google Home, Alexa,
HomeKit, MCP ou d’une scène ne peut jamais lancer le sauna.

## Installation

1. Sur le panneau de commande, activez le Modbus TCP et notez son adresse IP
   (à fixer de préférence dans votre box).
2. Dans Gladys, ouvrez l’intégration Saunum, saisissez l’**adresse** (par
   exemple `192.168.1.80`, ou `192.168.1.80:502`) et, si vous l’avez changé,
   l’**identifiant d’unité Modbus** (1 par défaut).
3. Enregistrez, puis ajoutez le sauna depuis l’onglet **Découverte**.
4. Pour lancer la chauffe depuis Gladys, activez **Autoriser le chauffage
   depuis Gladys**, et vérifiez la **consigne du bouton « Allumer »** (80 °C
   par défaut), la **consigne la plus haute** (90 °C par défaut, 100 °C au
   plus, la limite du panneau) et la **durée de séance du bouton « Allumer »**
   (60 min par défaut, de 60 à 720).

Le panneau n’accepte **qu’une connexion Modbus à la fois** : n’utilisez pas un
autre client Modbus (Home Assistant, un script) en même temps. L’intégration
n’ouvre jamais deux connexions, attend 500 ms entre deux requêtes (comme le
recommande la bibliothèque Saunum) et ferme sa connexion après 10 s sans
requête (le panneau la fermerait à 20 s).

Le panneau est lu toutes les 30 s (de 10 s à 10 min), **jamais plus souvent**,
même après un redémarrage, une reconnexion à Gladys, le bouton « Tester la
connexion » ou une recherche dans Découverte ; quelques secondes après chaque
commande, il est relu pour en montrer le résultat.

Un seul panneau par intégration : l’appareil garde son identifiant quand vous
changez l’adresse (nouveau bail DHCP, panneau remplacé). Les registres Modbus
ne donnent aucun numéro de série : l’intégration ne sait pas distinguer deux
panneaux, ne changez l’adresse que pour le même sauna.

## Les commandes

- **Éteindre** écrit « séance arrêtée » sur le panneau. Elle n’est retenue ni
  par l’option, ni par une commande de chauffe en cours, ni par des lectures en
  échec, ni par un redémarrage (elle fonctionne avant la première lecture).
  Elle est toujours écrite (jamais « déjà éteint »), passe avant toute lecture
  ou commande en attente (elle n’attend que la requête déjà partie et la
  pause de 0,5 s qui suit), et une commande de chauffe pas encore écrite s’efface devant elle.
  Elle est confirmée par l’écho du panneau ; sans réponse en 4,3 s, Gladys
  affiche « Envoyée, sans confirmation ». Elle échoue quand même si le panneau
  est injoignable (« Non envoyée ») ou la refuse (exception Modbus) :
  vérifiez alors le sauna.
- Quand un lancement peut encore arriver après une extinction (il est parti
  sans réponse), chaque lecture des deux minutes suivantes qui voit le sauna
  chauffer réécrit « arrêt » (3 fois au plus, gardé après un redémarrage).
  Cela peut aussi éteindre une séance lancée sur le panneau pendant ces deux
  minutes : c’est voulu.
- **Allumer (chauffer)** et la **consigne** sont refusés tant que « Autoriser
  le chauffage depuis Gladys » est désactivé. Activés, ils lisent d’abord le
  panneau (jamais l’état en mémoire) et sont refusés quand :
  - la porte est ouverte (pour la consigne : pendant une séance) ;
  - une alarme est active, ou un registre d’alarme a une valeur inconnue ;
  - le panneau signale une raison de ne pas démarrer (micrologiciel récent),
    ou son état n’est pas « En veille » (programmé, en attente de la porte,
    refroidissement) ;
  - une valeur nécessaire est inconnue (consigne, état du boîtier) ;
  - une extinction est en cours, en attente ou pas encore confirmée ; pour la
    consigne, aussi pendant les 2 min qui suivent une extinction ;
  - un lancement précédent n’est pas encore confirmé, ou une autre commande
    de chauffe est en cours ;
  - les lectures et écritures ne peuvent pas toutes partir dans les 3,5 s
    après le clic.
    L’option et l’extinction sont revérifiées juste avant chaque écriture.
- **Allumer** écrit la consigne du bouton « Allumer » et la durée de séance de
  la configuration (quand le panneau a d’autres valeurs), puis lance la
  séance. Séance déjà en cours : rien n’est écrit.
- **La consigne** est un nombre entier de 40 °C à la consigne la plus haute ;
  elle est refusée pendant le refroidissement (elle pourrait relancer la
  chauffe). Sans séance en cours, le panneau la garde, mais « Allumer » écrit
  sa propre consigne.
- **La lumière** est un simple marche/arrêt, une fois le panneau lu.

Chaque commande répond en 4,3 s au plus ; une écriture reçue par le panneau
sans réponse à temps est « Envoyée, sans confirmation ».

## Limites

- Jamais testé avec un vrai panneau : valeurs de registres inventées
  seulement. La carte des registres est celle de la bibliothèque pysaunum
  (Home Assistant).
- Micrologiciel ancien sans les registres 105 à 118 : ni humidité, ni temps
  restant, ni état du boîtier (redemandés toutes les 30 minutes).
- Ventilateur, type de sauna, AutoLeil et les autres réglages du panneau ne
  sont pas gérés.

## Dépannage

- « Le panneau ne répond pas » : vérifiez l’adresse, que le Modbus TCP est
  activé, et qu’aucun autre client Modbus ne tient la connexion.
- « invalid data » : l’appareil à cette adresse ne répond pas comme un panneau
  Saunum (registre de séance ou de porte hors de 0/1).

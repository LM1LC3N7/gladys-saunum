# Saunum pour Gladys

Cette intégration affiche un **sauna Saunum Leil** dans Gladys, par le Modbus
TCP de son panneau de commande sur votre réseau local. **Jamais testé avec un
vrai appareil.** Sans lien avec Saunum.

> **Sécurité.** Un sauna chauffe très fort. Ne lancez jamais la chauffe à
> distance sans vous assurer que personne n’est dedans et que rien ne repose
> sur le poêle. L’allumage depuis Gladys est **désactivé par défaut** et
> refusé porte ouverte ; l’extinction ne dépend pas de cette option (les cas où
> elle peut quand même échouer sont listés plus bas).

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
HomeKit, MCP ou d’une scène n’atteint pas le bouton d’allumage.

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

Le panneau peut n’accepter **qu’une connexion Modbus à la fois** (pas encore
vérifié sur un vrai panneau) : évitez d’utiliser un autre client Modbus (Home
Assistant, un script) en même temps. L’intégration ouvre une connexion à la
fois (une nouvelle adresse attend que la connexion précédente, même en cours
d’ouverture, soit fermée), attend 1 s entre deux lectures et 0,5 s avant une
commande (l’espacement recommandé et l’espacement minimal de la bibliothèque
pysaunum), et ferme sa connexion après 10 s sans requête (selon pysaunum, le
panneau la ferme à 20 s).

Le panneau est lu toutes les 30 s (de 10 s à 10 min), pas plus souvent après
un redémarrage, une reconnexion à Gladys, le bouton « Tester la connexion » ou
une recherche dans Découverte. Exceptions : quelques secondes après chaque
commande, et toutes les 10 s pendant la vérification d’une extinction ou d’un
lancement depuis Gladys (voir plus bas).

Un seul panneau par intégration : l’appareil garde son identifiant quand vous
changez l’adresse (nouveau bail DHCP, panneau remplacé). Les registres Modbus
ne donnent aucun numéro de série : l’intégration ne sait pas distinguer deux
panneaux, ne changez l’adresse que pour le même sauna.

## Les commandes

### Éteindre

Écrit « séance arrêtée » (registre 0 = 0) sur le panneau. Elle ne dépend ni de
l’option « Autoriser le chauffage », ni d’une commande de chauffe en cours, ni
de lectures en échec, ni de la première lecture après un redémarrage. Elle est
toujours écrite (jamais « déjà éteint »), passe avant toute lecture ou commande
en attente, coupe une lecture déjà partie, et une écriture de chauffe pas
encore partie s’efface devant elle. Elle n’attend qu’une écriture déjà partie
et l’espacement de 0,5 s qui suit.

Elle est acceptée sur l’écho du panneau, puis **vérifiée par les lectures** :
le panneau est relu 5 s et 20 s après, et toutes les 10 s pendant 2 minutes au
plus, jusqu’à une lecture qui montre le sauna arrêté. Une lecture qui le
montre de nouveau en chauffe (sans lancement depuis Gladys après l’extinction)
réécrit « arrêt », 3 fois au plus, avec un avertissement dans le journal et
dans le statut (« une extinction n’a pas pris effet »). Cela peut aussi éteindre
une séance lancée sur le panneau pendant ces deux minutes : c’est voulu. Quand
un lancement peut encore arriver après l’extinction (parti sans réponse), cette
garde dure 2 minutes quoi que montrent les lectures, et elle est gardée après
un redémarrage.

L’extinction est refusée, ou échoue, quand :

- la valeur n’est pas 1, ou l’appareil n’est pas le panneau de cette
  intégration ;
- la configuration n’est pas chargée dans les 3,5 s après le clic (« La
  configuration n’est pas encore chargée »), ou il n’y a pas d’adresse ou
  d’identifiant d’unité Modbus valide ;
- le panneau est injoignable (« Non envoyée », vérifiez le sauna) ;
- le panneau refuse l’écriture (exception Modbus ; un panneau occupé,
  exception 5 ou 6, a droit à un nouvel essai) ;
- elle attend encore à 4,3 s (une écriture en cours, une connexion lente) :
  « Pas encore envoyée », elle part dès que possible ;
- elle est partie mais le panneau n’a pas répondu à temps : « Envoyée, sans
  confirmation ».

### Allumer (chauffer)

Refusé quand :

- « Autoriser le chauffage depuis Gladys » est désactivé (vérifié à l’arrivée
  et juste avant chaque écriture) ;
- la configuration n’est pas chargée, ou n’a pas d’adresse ou d’identifiant
  d’unité valide ; l’appareil n’est pas le panneau de cette intégration ; la
  configuration change pendant la commande ;
- une autre commande de chauffe est en cours, ou un lancement précédent n’est
  pas encore confirmé ;
- une extinction est en cours, en attente, ou pas encore vérifiée par une
  lecture (ou elle est demandée pendant la commande) ;
- la lecture fraîche échoue (injoignable, pas de réponse, données invalides)
  ou ne peut pas se faire dans les 3,5 s ;
- l’appareil n’a pas l’empreinte d’un panneau Saunum (un registre hors de la
  plage documentée par pysaunum), ou un panneau qui servait les registres
  105 à 118 ne les sert plus ;
- une alarme est active, ou un registre d’alarme a une valeur inconnue ;
- la porte est ouverte ;
- le sauna refroidit ; sur micrologiciel récent : l’état n’est pas « En
  veille » (ou il est inconnu), ou le panneau signale une raison de ne pas
  démarrer ;
- les écritures ne peuvent pas toutes partir dans les 3,5 s après le clic
  (estimé après la lecture fraîche : rien n’est alors écrit) ;
- le panneau refuse une écriture (exception Modbus) ou une écriture ne peut pas
  partir.

Séance déjà en cours : rien n’est écrit (accepté). Sinon, la consigne du bouton
« Allumer » et la durée de séance de la configuration sont écrites (quand le
panneau a d’autres valeurs), puis la séance est lancée. Si le lancement est
refusé après l’écriture de la consigne ou de la durée, le message le dit (la
séance n’est pas lancée).

**Le lancement est ensuite vérifié par les lectures** (5 s, 20 s, puis toutes
les 10 s jusqu’à vérification, et à chaque lecture pendant la séance) : la
consigne ne doit être ni 0 (celle du préréglage) ni au-dessus de la consigne la
plus haute, la durée doit être celle écrite, et sur micrologiciel récent la
durée de séance active (registre 106) et le temps restant doivent
correspondre. Sinon, ou si aucune lecture n’a pu le vérifier en une minute, le
sauna est éteint, avec un avertissement dans le journal et le statut.

### Consigne

Un nombre entier de 40 °C à la consigne la plus haute. Refusée quand :

- l’option est désactivée, la configuration n’est pas chargée ou pas valide,
  l’appareil n’est pas le nôtre, ou la configuration change pendant la
  commande ;
- une autre commande de chauffe est en cours ; une extinction est en cours, en
  attente ou pas encore vérifiée ; ou une extinction date de moins de 2 min ;
- la lecture fraîche échoue ou ne peut pas se faire dans les 3,5 s ;
  l’empreinte manque, ou les registres 105 à 118 ne sont plus servis ;
- une alarme est active ou inconnue ; la consigne actuelle est inconnue ;
- le sauna refroidit (registre 109 quand il est servi ; sinon une séance en
  cours avec une consigne à 0) ;
- la porte est ouverte : sur micrologiciel récent dans tout état autre que
  « En veille » ; sur un ancien, pendant une séance ;
- l’écriture ne peut pas partir dans les 3,5 s, ou le panneau la refuse.

Même consigne déjà en place : rien n’est écrit. Sans séance en cours,
« Allumer » écrit de toute façon sa propre consigne.

### Lumière

Marche/arrêt (0 ou 1), après une lecture fraîche portant l’empreinte d’un
panneau Saunum. Refusée quand la valeur n’est pas 0 ou 1, que la configuration
n’est pas chargée ou pas valide, que la lecture fraîche échoue ou n’a pas
l’empreinte, ou que l’écriture ne peut pas partir ou est refusée.

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
- Un avertissement dans le statut (« la séance lancée depuis Gladys n’a pas
  gardé ses valeurs », « une extinction n’a pas pris effet ») : vérifiez le
  sauna ; il reste jusqu’au prochain lancement depuis Gladys ou une nouvelle
  configuration.
